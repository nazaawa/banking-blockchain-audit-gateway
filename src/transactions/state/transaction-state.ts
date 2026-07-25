import {
  BankProcessingStatus,
  CaseStatus,
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../../mobile-money/enums/mobile-money.enum';
import { TransactionStatus } from '../enums/transaction-status.enum';

/**
 * Etat d'une transaction, reduit a ses seules dimensions de statut.
 *
 * Les cinq jambes sont modelisees separement parce qu'elles decrivent des faits
 * independants : un encaissement fournisseur reussi coexiste legitimement avec
 * une instruction bancaire bloquee. Les fondre en un statut unique obligerait a
 * ecraser un fait vrai par un autre.
 *
 * Cette independance a un cout : l'espace produit compte plusieurs milliers de
 * combinaisons, dont l'immense majorite ne correspond a rien. C'est ce que les
 * deux mecanismes ci-dessous encadrent.
 */
export interface TransactionState {
  status: TransactionStatus;
  providerStatus: ProviderStatus | null;
  bankStatus: BankProcessingStatus | null;
  reconciliationStatus: ReconciliationStatus | null;
  refundStatus: RefundStatus | null;
  caseStatus: CaseStatus | null;
  paymentChannel: PaymentChannel;
}

/** Dimension soumise a une table de transitions. */
export type StateDimension = Exclude<keyof TransactionState, 'paymentChannel'>;

/**
 * Transitions autorisees, par dimension.
 *
 * Une valeur absente de la table est **terminale** : plus aucun changement n'est
 * admis. Une valeur qui se reecrit a l'identique est toujours toleree — les
 * services persistent l'entite entiere, et exiger qu'ils omettent les champs
 * inchanges rendrait chaque appelant responsable d'un detail de persistance.
 */
export const TRANSITIONS: {
  readonly [D in StateDimension]: Readonly<Record<string, readonly string[]>>;
} = {
  // Vue de synthese heritee du flux classique. Elle reste utile a l'API, mais
  // ce sont les jambes ci-dessous qui portent la verite metier.
  status: {
    [TransactionStatus.PENDING]: [
      TransactionStatus.PROCESSING,
      TransactionStatus.COMPLETED,
      TransactionStatus.FAILED,
    ],
    [TransactionStatus.PROCESSING]: [TransactionStatus.COMPLETED, TransactionStatus.FAILED],
  },

  // Un encaissement constate ne se dement pas : le payeur a ete debite ou il ne
  // l'a pas ete. C'est cette irreversibilite qui rend la dette lisible en aval.
  providerStatus: {
    [ProviderStatus.INITIATED]: [
      ProviderStatus.PENDING,
      ProviderStatus.CONFIRMED,
      ProviderStatus.FAILED,
    ],
    [ProviderStatus.PENDING]: [ProviderStatus.CONFIRMED, ProviderStatus.FAILED],
  },

  // BLOCKED est un refus assume d'instruire la banque, distinct d'un echec subi.
  // Les deux sont terminaux : on ne reprend pas une instruction bancaire.
  bankStatus: {
    [BankProcessingStatus.NOT_STARTED]: [
      BankProcessingStatus.PROCESSING,
      BankProcessingStatus.BLOCKED,
    ],
    [BankProcessingStatus.PROCESSING]: [
      BankProcessingStatus.COMPLETED,
      BankProcessingStatus.FAILED,
    ],
  },

  // Seul le rapprochement peut etre rejoue : tant que les deux jambes ne sont
  // pas terminees, il repasse par PENDING ou MANUAL_REVIEW sans conclure.
  reconciliationStatus: {
    [ReconciliationStatus.PENDING]: [
      ReconciliationStatus.MATCHED,
      ReconciliationStatus.MISMATCH,
      ReconciliationStatus.AMOUNT_MISMATCH,
      ReconciliationStatus.CURRENCY_MISMATCH,
      ReconciliationStatus.NOT_APPLICABLE,
      ReconciliationStatus.MANUAL_REVIEW,
    ],
    [ReconciliationStatus.MANUAL_REVIEW]: [
      ReconciliationStatus.MATCHED,
      ReconciliationStatus.MISMATCH,
      ReconciliationStatus.PENDING,
    ],
    [ReconciliationStatus.MISMATCH]: [ReconciliationStatus.MANUAL_REVIEW],
  },

  // FAILED reste rejouable : une indisponibilite du fournisseur n'eteint pas la
  // dette, et un refus metier peut etre leve par une reouverture explicite.
  //
  // `FAILED -> COMPLETED` est admis parce que la vue metier n'est resynchronisee
  // qu'a la premiere tentative : une reprise qui aboutit passe donc directement
  // de l'echec a l'extinction, sans repasser par REQUESTED. C'est le dossier de
  // remboursement lui-meme qui porte le detail des tentatives.
  refundStatus: {
    [RefundStatus.NOT_REQUIRED]: [RefundStatus.REQUIRED],
    [RefundStatus.REQUIRED]: [RefundStatus.REQUESTED, RefundStatus.COMPLETED, RefundStatus.FAILED],
    [RefundStatus.REQUESTED]: [RefundStatus.COMPLETED, RefundStatus.FAILED],
    [RefundStatus.FAILED]: [RefundStatus.REQUESTED, RefundStatus.REQUIRED, RefundStatus.COMPLETED],
  },

  caseStatus: {
    [CaseStatus.NONE]: [CaseStatus.MANUAL_REVIEW],
    [CaseStatus.MANUAL_REVIEW]: [CaseStatus.RESOLVED],
  },
};

/** Regle portant sur l'etat resultant, toutes dimensions confondues. */
export interface StateInvariant {
  readonly name: string;
  /** `true` si l'etat est acceptable. */
  readonly holds: (state: TransactionState) => boolean;
  readonly because: string;
}

const REFUND_ENGAGED: readonly RefundStatus[] = [
  RefundStatus.REQUIRED,
  RefundStatus.REQUESTED,
  RefundStatus.COMPLETED,
  RefundStatus.FAILED,
];

/**
 * Invariants entre dimensions.
 *
 * La table de transitions ne voit qu'une dimension a la fois : elle laisserait
 * passer une instruction bancaire executee alors que le fournisseur a echoue.
 * Chaque regle ci-dessous ferme une combinaison qui n'a pas de sens metier.
 */
export const INVARIANTS: readonly StateInvariant[] = [
  {
    name: 'bank-requires-provider-confirmation',
    holds: (state) =>
      state.paymentChannel !== PaymentChannel.MOBILE_MONEY ||
      state.bankStatus === null ||
      state.bankStatus === BankProcessingStatus.NOT_STARTED ||
      state.providerStatus === ProviderStatus.CONFIRMED,
    because:
      'la banque ne peut etre instruite que sur un encaissement fournisseur confirme : ' +
      'c est le garde-fou qui empeche un mouvement de fonds sans contrepartie',
  },
  {
    name: 'refund-requires-collection',
    holds: (state) =>
      state.paymentChannel !== PaymentChannel.MOBILE_MONEY ||
      state.refundStatus === null ||
      !REFUND_ENGAGED.includes(state.refundStatus) ||
      state.providerStatus === ProviderStatus.CONFIRMED,
    because: 'on ne rembourse que ce qui a ete encaisse',
  },
  {
    name: 'resolved-case-requires-extinct-debt',
    holds: (state) =>
      state.caseStatus !== CaseStatus.RESOLVED ||
      state.refundStatus === RefundStatus.COMPLETED ||
      state.refundStatus === RefundStatus.NOT_REQUIRED ||
      state.refundStatus === null,
    because:
      'un dossier ne peut etre resolu tant que la dette envers le payeur subsiste — ' +
      'or la resolution ouvre la cloture, donc l ancrage',
  },
  {
    name: 'matched-requires-both-legs-done',
    holds: (state) =>
      state.reconciliationStatus !== ReconciliationStatus.MATCHED ||
      state.paymentChannel !== PaymentChannel.MOBILE_MONEY ||
      (state.providerStatus === ProviderStatus.CONFIRMED &&
        state.bankStatus === BankProcessingStatus.COMPLETED),
    because: 'un rapprochement conforme suppose que les deux jambes ont abouti',
  },
  {
    name: 'blocked-bank-implies-declared-gap',
    holds: (state) =>
      state.bankStatus !== BankProcessingStatus.BLOCKED ||
      state.reconciliationStatus === ReconciliationStatus.AMOUNT_MISMATCH ||
      state.reconciliationStatus === ReconciliationStatus.CURRENCY_MISMATCH,
    because: 'un blocage bancaire est toujours motive par un ecart constate et nomme',
  },
];

import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { EntryDirection, LedgerAccount } from './enums/ledger.enum';

/** Mouvement elementaire : un compte, un sens, un montant positif. */
export interface PostingLine {
  account: LedgerAccount;
  direction: EntryDirection;
  amount: number;
}

/** Grandeurs disponibles au moment de comptabiliser un fait. */
export interface PostingContext {
  /** Montant commande. */
  ordered: number;
  /** Montant reellement constate, quand il differe de l'attendu. */
  observed: number | null;
  /** Commission retenue par la passerelle, figee a la confirmation. */
  fee: number;
}

export interface PostingRule {
  narration: string;
  lines: (context: PostingContext) => PostingLine[];
}

const debit = (account: LedgerAccount, amount: number): PostingLine => ({
  account,
  direction: EntryDirection.DEBIT,
  amount,
});

const credit = (account: LedgerAccount, amount: number): PostingLine => ({
  account,
  direction: EntryDirection.CREDIT,
  amount,
});

/** Ecarte les lignes nulles : une commission de zero n'a pas a figurer. */
const withoutZeros = (lines: PostingLine[]): PostingLine[] =>
  lines.filter((line) => line.amount > 0);

/**
 * Consequence comptable de chaque fait monetaire.
 *
 * Les faits absents de cette table n'ont **aucun** effet comptable : ils
 * decrivent un changement d'etat, pas un mouvement de fonds. Un rapprochement
 * conforme, par exemple, constate que les deux jambes concordent — il ne
 * deplace rien.
 *
 * Toutes les regles produisent des lignes dont la somme des debits egale celle
 * des credits. Un declencheur en base le verifie a l'insertion : la propriete
 * ne depend donc pas de la justesse de ce fichier.
 */
export const POSTING_RULES: Partial<Record<TransactionEventType, PostingRule>> = {
  /**
   * Encaissement conforme a la commande.
   *
   * La commission est acquise ici parce que le service est en cours de
   * fourniture ; elle sera restituee si la jambe bancaire echoue.
   */
  [TransactionEventType.PROVIDER_CONFIRMED]: {
    narration: 'Encaissement fournisseur, commission retenue',
    lines: ({ ordered, observed, fee }) => {
      const collected = observed ?? ordered;
      return withoutZeros([
        debit(LedgerAccount.PROVIDER_FLOAT, collected),
        credit(LedgerAccount.CREDITOR_PAYABLE, collected - fee),
        credit(LedgerAccount.FEE_REVENUE, fee),
      ]);
    },
  },

  /**
   * Encaissement non conforme : la banque ne sera pas instruite.
   *
   * Rien n'est du au beneficiaire — le virement n'aura pas lieu — et aucune
   * commission n'est acquise, faute de service rendu. L'integralite de ce qui a
   * ete preleve est due au payeur.
   */
  [TransactionEventType.AMOUNT_MISMATCH_DETECTED]: {
    narration: 'Encaissement non conforme : dette envers le payeur',
    lines: ({ ordered, observed }) => {
      const collected = observed ?? ordered;
      return withoutZeros([
        debit(LedgerAccount.PROVIDER_FLOAT, collected),
        credit(LedgerAccount.PAYER_PAYABLE, collected),
      ]);
    },
  },

  /** Rapatriement des fonds de l'agregateur vers le compte bancaire. */
  [TransactionEventType.SETTLEMENT_SWEPT]: {
    narration: 'Rapatriement agregateur vers compte de reglement',
    lines: ({ ordered, observed }) => {
      const swept = observed ?? ordered;
      return withoutZeros([
        debit(LedgerAccount.SETTLEMENT, swept),
        credit(LedgerAccount.PROVIDER_FLOAT, swept),
      ]);
    },
  },

  /** Le beneficiaire a ete paye : la dette envers lui s'eteint. */
  [TransactionEventType.BANK_PROCESSING_COMPLETED]: {
    narration: 'Reglement du beneficiaire',
    lines: ({ ordered, fee }) =>
      withoutZeros([
        debit(LedgerAccount.CREDITOR_PAYABLE, ordered - fee),
        credit(LedgerAccount.SETTLEMENT, ordered - fee),
      ]),
  },

  /**
   * Encaisse mais jamais livre : l'obligation se deplace.
   *
   * La commission est contre-passee : le service n'a pas ete rendu, la
   * conserver reviendrait a facturer un echec.
   */
  [TransactionEventType.BANK_PROCESSING_FAILED]: {
    narration: 'Echec bancaire : la dette passe du beneficiaire au payeur',
    lines: ({ ordered, fee }) =>
      withoutZeros([
        debit(LedgerAccount.CREDITOR_PAYABLE, ordered - fee),
        debit(LedgerAccount.FEE_REVENUE, fee),
        credit(LedgerAccount.PAYER_PAYABLE, ordered),
      ]),
  },

  /** La dette envers le payeur est eteinte par restitution des fonds. */
  [TransactionEventType.REFUND_COMPLETED]: {
    narration: 'Remboursement du payeur',
    lines: ({ ordered, observed }) => {
      const refunded = observed ?? ordered;
      return withoutZeros([
        debit(LedgerAccount.PAYER_PAYABLE, refunded),
        credit(LedgerAccount.PROVIDER_FLOAT, refunded),
      ]);
    },
  },
};

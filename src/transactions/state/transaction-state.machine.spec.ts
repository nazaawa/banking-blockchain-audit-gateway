import {
  BankProcessingStatus,
  CaseStatus,
  PaymentChannel,
  ProviderStatus,
  ReconciliationStatus,
  RefundStatus,
} from '../../mobile-money/enums/mobile-money.enum';
import { TransactionStatus } from '../enums/transaction-status.enum';
import { IllegalTransitionException } from './illegal-transition.exception';
import { TransactionStateMachine } from './transaction-state.machine';
import type { TransactionState } from './transaction-state';

const REFERENCE = 'TRF-20260725-8F3A2C71';

const state = (overrides: Partial<TransactionState> = {}): TransactionState => ({
  status: TransactionStatus.PENDING,
  providerStatus: ProviderStatus.PENDING,
  bankStatus: BankProcessingStatus.NOT_STARTED,
  reconciliationStatus: ReconciliationStatus.PENDING,
  refundStatus: RefundStatus.NOT_REQUIRED,
  caseStatus: CaseStatus.NONE,
  paymentChannel: PaymentChannel.MOBILE_MONEY,
  ...overrides,
});

describe('TransactionStateMachine', () => {
  let machine: TransactionStateMachine;

  beforeEach(() => {
    machine = new TransactionStateMachine();
    // La machine journalise chaque refus ; l'inhiber garde la sortie de test lisible.
    jest.spyOn(machine['logger'], 'error').mockImplementation(() => undefined);
  });

  const assert = (before: TransactionState, after: TransactionState): void =>
    machine.assertTransition(before, after, REFERENCE);

  // ==========================================================================

  describe('Chemins reels du flux', () => {
    it('accepte la confirmation fournisseur puis la prise de la jambe bancaire', () => {
      expect(() =>
        assert(
          state(),
          state({
            status: TransactionStatus.PROCESSING,
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.PROCESSING,
          }),
        ),
      ).not.toThrow();
    });

    it('accepte le blocage bancaire sur ecart de montant', () => {
      expect(() =>
        assert(
          state(),
          state({
            status: TransactionStatus.FAILED,
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.BLOCKED,
            reconciliationStatus: ReconciliationStatus.AMOUNT_MISMATCH,
            refundStatus: RefundStatus.REQUIRED,
            caseStatus: CaseStatus.MANUAL_REVIEW,
          }),
        ),
      ).not.toThrow();
    });

    it('accepte la resolution du dossier une fois le remboursement abouti', () => {
      const disputed = state({
        status: TransactionStatus.FAILED,
        providerStatus: ProviderStatus.CONFIRMED,
        bankStatus: BankProcessingStatus.BLOCKED,
        reconciliationStatus: ReconciliationStatus.AMOUNT_MISMATCH,
        refundStatus: RefundStatus.REQUESTED,
        caseStatus: CaseStatus.MANUAL_REVIEW,
      });

      expect(() =>
        assert(
          disputed,
          state({
            ...disputed,
            refundStatus: RefundStatus.COMPLETED,
            caseStatus: CaseStatus.RESOLVED,
          }),
        ),
      ).not.toThrow();
    });

    it('tolere la reecriture a l identique', () => {
      // Les services persistent l'entite entiere : exiger qu'ils omettent les
      // champs inchanges deplacerait un detail de persistance chez l'appelant.
      expect(() => assert(state(), state())).not.toThrow();
    });
  });

  // ==========================================================================

  describe('Transitions refusees', () => {
    it('REFUSE un retour en arriere du remboursement', () => {
      expect(() =>
        assert(
          state({ providerStatus: ProviderStatus.CONFIRMED, refundStatus: RefundStatus.COMPLETED }),
          state({ providerStatus: ProviderStatus.CONFIRMED, refundStatus: RefundStatus.REQUESTED }),
        ),
      ).toThrow(IllegalTransitionException);
    });

    it('REFUSE de dementir un encaissement constate', () => {
      // Le payeur a ete debite ou il ne l'a pas ete : ce fait ne se reecrit pas.
      expect(() =>
        assert(
          state({ providerStatus: ProviderStatus.CONFIRMED }),
          state({ providerStatus: ProviderStatus.FAILED }),
        ),
      ).toThrow(/providerStatus : CONFIRMED est terminal/);
    });

    it('REFUSE de reprendre une instruction bancaire bloquee', () => {
      expect(() =>
        assert(
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.BLOCKED,
            reconciliationStatus: ReconciliationStatus.AMOUNT_MISMATCH,
          }),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.PROCESSING,
            reconciliationStatus: ReconciliationStatus.AMOUNT_MISMATCH,
          }),
        ),
      ).toThrow(/bankStatus : BLOCKED est terminal/);
    });

    it('REFUSE de sauter l etape REQUIRED du remboursement', () => {
      expect(() =>
        assert(
          state({ providerStatus: ProviderStatus.CONFIRMED }),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            refundStatus: RefundStatus.COMPLETED,
          }),
        ),
      ).toThrow(/refundStatus : NOT_REQUIRED -> COMPLETED/);
    });
  });

  // ==========================================================================

  describe('Etats impossibles fermes par les invariants', () => {
    it('REFUSE d instruire la banque sans encaissement confirme', () => {
      // Combinaison que les tables seules laisseraient passer : chaque dimension
      // evolue legalement, c'est leur conjonction qui n'a pas de sens.
      expect(() =>
        assert(
          state(),
          state({
            providerStatus: ProviderStatus.PENDING,
            bankStatus: BankProcessingStatus.PROCESSING,
          }),
        ),
      ).toThrow(/bank-requires-provider-confirmation/);
    });

    it('REFUSE de rembourser ce qui n a pas ete encaisse', () => {
      expect(() =>
        assert(
          state(),
          state({ providerStatus: ProviderStatus.PENDING, refundStatus: RefundStatus.REQUIRED }),
        ),
      ).toThrow(/refund-requires-collection/);
    });

    it('REFUSE de resoudre un dossier dont la dette subsiste', () => {
      // C'est la resolution qui ouvre la cloture, donc l'ancrage : sceller ici
      // publierait une extinction de dette qui n'a pas eu lieu.
      expect(() =>
        assert(
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            refundStatus: RefundStatus.REQUIRED,
            caseStatus: CaseStatus.MANUAL_REVIEW,
          }),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            refundStatus: RefundStatus.REQUIRED,
            caseStatus: CaseStatus.RESOLVED,
          }),
        ),
      ).toThrow(/resolved-case-requires-extinct-debt/);
    });

    it('REFUSE un rapprochement conforme dont une jambe n a pas abouti', () => {
      expect(() =>
        assert(
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.PROCESSING,
          }),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.PROCESSING,
            reconciliationStatus: ReconciliationStatus.MATCHED,
          }),
        ),
      ).toThrow(/matched-requires-both-legs-done/);
    });

    it('REFUSE un blocage bancaire sans ecart nomme', () => {
      expect(() =>
        assert(
          state(),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            bankStatus: BankProcessingStatus.BLOCKED,
            reconciliationStatus: ReconciliationStatus.PENDING,
          }),
        ),
      ).toThrow(/blocked-bank-implies-declared-gap/);
    });
  });

  // ==========================================================================

  describe('Diagnostic', () => {
    it('rapporte toutes les violations, pas seulement la premiere', () => {
      try {
        assert(
          state({ providerStatus: ProviderStatus.CONFIRMED, refundStatus: RefundStatus.COMPLETED }),
          state({
            providerStatus: ProviderStatus.CONFIRMED,
            refundStatus: RefundStatus.REQUESTED,
            bankStatus: BankProcessingStatus.BLOCKED,
            reconciliationStatus: ReconciliationStatus.PENDING,
          }),
        );
        throw new Error('la transition aurait du etre refusee');
      } catch (error) {
        // Un diagnostic partiel ferait corriger un symptome a la fois.
        expect((error as IllegalTransitionException).violations).toHaveLength(2);
      }
    });

    it('n applique pas les regles Mobile Money au virement classique', () => {
      // Le flux classique n'a ni jambe fournisseur ni dette : ses colonnes
      // restent nulles, et les invariants correspondants ne s appliquent pas.
      expect(() =>
        assert(
          state({
            paymentChannel: PaymentChannel.LEGACY_TRANSFER,
            providerStatus: null,
            bankStatus: null,
            reconciliationStatus: null,
          }),
          state({
            paymentChannel: PaymentChannel.LEGACY_TRANSFER,
            providerStatus: null,
            bankStatus: null,
            reconciliationStatus: null,
            status: TransactionStatus.COMPLETED,
          }),
        ),
      ).not.toThrow();
    });
  });
});

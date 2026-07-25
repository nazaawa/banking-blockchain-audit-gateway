import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { TransactionEventsService } from '../events/transaction-events.service';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { CaseStatus, RefundStatus } from '../mobile-money/enums/mobile-money.enum';
import type { Transaction } from '../transactions/entities/transaction.entity';
import { RefundResponseDto } from './dto/refund-response.dto';
import { Refund } from './entities/refund.entity';
import {
  ProviderRefundRejectedException,
  ProviderRefundUnavailableException,
  type ProviderRefundPort,
} from './provider-refund.port';
import { TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import type { MetricsService } from '../observability/metrics.service';
import { EventActionOrigin, EventActorRole } from '../events/enums/event-actor.enum';
import { RefundsService } from './refunds.service';

describe('RefundsService', () => {
  let transaction: Transaction;
  let storedRefund: Refund | null;
  let refunds: jest.Mocked<Repository<Refund>>;
  let transactions: jest.Mocked<Repository<Transaction>>;
  let events: jest.Mocked<TransactionEventsService>;
  let provider: jest.Mocked<ProviderRefundPort>;
  let dataSource: jest.Mocked<DataSource>;
  let service: RefundsService;

  beforeEach(() => {
    transaction = {
      id: 'tx-id',
      reference: 'TRF-20260725-8F3A2C71',
      aggregatorReference: 'AGG-20260725-A1B2C3D4',
      aggregatorAmount: 1,
      aggregatorCurrency: 'CDF',
      refundStatus: RefundStatus.REQUIRED,
      caseStatus: CaseStatus.MANUAL_REVIEW,
      caseReason: 'Montant confirme different',
      failureReason: null,
      correlationId: 'corr-refund',
    } as Transaction;
    storedRefund = null;

    refunds = {
      findOne: jest.fn(async () => storedRefund),
      create: jest.fn(
        (value) =>
          ({
            id: 'refund-id',
            providerRefundReference: null,
            lastError: null,
            requestedAt: null,
            completedAt: null,
            createdAt: new Date('2026-07-25T10:00:00.000Z'),
            updatedAt: new Date('2026-07-25T10:00:00.000Z'),
            ...value,
          }) as Refund,
      ),
      save: jest.fn(async (value) => {
        storedRefund = value as Refund;
        return storedRefund;
      }),
      find: jest.fn(async () =>
        storedRefund?.retryable &&
        [RefundStatus.REQUESTED, RefundStatus.FAILED].includes(storedRefund.status)
          ? [storedRefund]
          : [],
      ),
    } as unknown as jest.Mocked<Repository<Refund>>;

    transactions = {
      findOne: jest.fn(async () => transaction),
      update: jest.fn(async (_criteria, changes) => {
        Object.assign(transaction, changes);
        return { affected: 1, generatedMaps: [], raw: [] };
      }),
      findOneByOrFail: jest.fn(async () => transaction),
    } as unknown as jest.Mocked<Repository<Transaction>>;

    events = {
      record: jest.fn(async () => undefined),
      closeCase: jest.fn(async () => null),
    } as unknown as jest.Mocked<TransactionEventsService>;

    provider = {
      refund: jest.fn(async (_request: Parameters<ProviderRefundPort['refund']>[0]) => ({
        providerRefundReference: 'RFN-A1B2C3',
        deduplicated: false,
      })),
    };

    dataSource = {
      transaction: jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) =>
        work({
          getRepository: (entity: unknown) => (entity === Refund ? refunds : transactions),
        } as unknown as EntityManager),
      ),
    } as unknown as jest.Mocked<DataSource>;

    service = new RefundsService(
      refunds,
      transactions,
      events,
      new TransactionStateMachine(),
      // Les compteurs sont observes ailleurs : ici seule la mecanique de
      // remboursement est eprouvee.
      { refundsFailed: { inc: jest.fn() } } as unknown as MetricsService,
      provider,
      dataSource,
    );
  });

  it('rembourse le montant effectivement encaisse et reste idempotent', async () => {
    const first = await service.requestRefund(transaction.reference, 'ops');
    const replay = await service.requestRefund(transaction.reference, 'ops');

    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect(provider.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        providerReference: transaction.aggregatorReference,
        amount: 1,
        currency: 'CDF',
      }),
    );
    expect(first.status).toBe(RefundStatus.COMPLETED);
    expect(replay).toBe(first);
    expect(transaction.refundStatus).toBe(RefundStatus.COMPLETED);
    expect(transaction.caseStatus).toBe(CaseStatus.RESOLVED);
    // Le second argument est la transaction SQL de l'ecriture metier : c'est
    // elle qui interdit qu'un remboursement aboutisse sans son fait consigne.
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: TransactionEventType.REFUND_REQUESTED }),
      expect.anything(),
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: TransactionEventType.REFUND_COMPLETED }),
      expect.anything(),
    );
    expect(events.closeCase).toHaveBeenCalledWith(
      transaction,
      'Dossier clos apres remboursement du payeur',
      expect.anything(),
    );
  });

  it('ne relance pas automatiquement un refus metier terminal', async () => {
    transaction.aggregatorAmount = 2.13;
    provider.refund.mockRejectedValue(
      new ProviderRefundRejectedException('Solde marchand insuffisant'),
    );

    const failed = await service.requestRefund(transaction.reference, 'ops');
    const retrySummary = await service.retryPending();
    const manualReplay = await service.requestRefund(transaction.reference, 'ops');

    expect(failed.status).toBe(RefundStatus.FAILED);
    expect(failed.retryable).toBe(false);
    expect(retrySummary).toEqual({ examined: 0, completed: 0 });
    expect(manualReplay).toBe(failed);
    expect(provider.refund).toHaveBeenCalledTimes(1);
  });

  it('rouvre explicitement un refus metier avant de le rejouer', async () => {
    provider.refund.mockRejectedValueOnce(
      new ProviderRefundRejectedException('Solde marchand insuffisant'),
    );

    const failed = await service.requestRefund(transaction.reference, 'ops');
    expect(failed.retryable).toBe(false);

    const reopened = await service.reopenRefund(transaction.reference, 'superviseur');
    expect(reopened.retryable).toBe(true);
    expect(reopened.lastError).toBeNull();

    const completed = await service.requestRefund(transaction.reference, 'ops');

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionEventType.REFUND_REOPENED,
        actorId: 'superviseur',
        actorRole: EventActorRole.REFUND_APPROVER,
        actionOrigin: EventActionOrigin.API,
      }),
      expect.anything(),
    );
    expect(completed.status).toBe(RefundStatus.COMPLETED);
    expect(provider.refund).toHaveBeenCalledTimes(2);
  });

  it('compare la reouverture au dernier operateur apres une reprise manuelle', async () => {
    provider.refund
      .mockRejectedValueOnce(new ProviderRefundUnavailableException('Fournisseur indisponible'))
      .mockRejectedValueOnce(new ProviderRefundRejectedException('Solde marchand insuffisant'));

    const temporaryFailure = await service.requestRefund(transaction.reference, 'acteur-a');
    expect(temporaryFailure.retryable).toBe(true);

    const businessRejection = await service.requestRefund(transaction.reference, 'acteur-b');
    expect(businessRejection.retryable).toBe(false);
    expect(businessRejection.createdBy).toBe('acteur-a');
    expect(businessRejection.lastRequestedBy).toBe('acteur-b');

    await expect(service.reopenRefund(transaction.reference, 'acteur-b')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'SEGREGATION_OF_DUTIES' }),
    });

    const requestEvents = events.record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === TransactionEventType.REFUND_REQUESTED);
    expect(requestEvents).toHaveLength(2);
    expect(requestEvents.map((event) => event.actorId)).toEqual(['acteur-a', 'acteur-b']);
  });

  it('refuse de rouvrir un dossier deja rejouable', async () => {
    storedRefund = refunds.create({
      transactionReference: transaction.reference,
      status: RefundStatus.FAILED,
      retryable: true,
    });

    await expect(service.reopenRefund(transaction.reference, 'ops')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'REFUND_ALREADY_RETRYABLE' }),
    });
    expect(events.record).not.toHaveBeenCalled();
  });

  it('ne publie jamais la cle d idempotence fournisseur', async () => {
    const refund = await service.requestRefund(transaction.reference, 'ops');
    const response = RefundResponseDto.fromEntity(refund);

    expect(response).not.toHaveProperty('providerIdempotencyKey');
    expect(response).not.toHaveProperty('retryable');
    expect(response).toMatchObject({
      transactionReference: transaction.reference,
      status: RefundStatus.COMPLETED,
      amount: 1,
      currency: 'CDF',
    });
  });
});

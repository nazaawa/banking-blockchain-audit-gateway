import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import {
  BankProcessingStatus,
  ProviderStatus,
  PaymentChannel,
  ReconciliationStatus,
} from './enums/mobile-money.enum';
import { TransactionStateMachine } from '../transactions/state/transaction-state.machine';
import { ReconciliationService } from './reconciliation.service';
import { TransactionEventsService } from '../events/transaction-events.service';

const payment = (overrides: Partial<Transaction> = {}): Transaction =>
  Object.assign(new Transaction(), {
    reference: 'TRF-20260725-8F3A2C71',
    paymentChannel: PaymentChannel.MOBILE_MONEY,
    status: TransactionStatus.COMPLETED,
    providerStatus: ProviderStatus.CONFIRMED,
    bankStatus: BankProcessingStatus.COMPLETED,
    reconciliationStatus: ReconciliationStatus.PENDING,
    amount: 1250.75,
    currency: 'CDF',
    aggregatorAmount: 1250.75,
    aggregatorCurrency: 'CDF',
    ...overrides,
  });

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let repository: jest.Mocked<Repository<Transaction>>;
  let eventLedger: jest.Mocked<TransactionEventsService>;

  beforeEach(async () => {
    repository = {
      save: jest.fn(async (value: Transaction) => value),
      find: jest.fn(async () => []),
    } as unknown as jest.Mocked<Repository<Transaction>>;
    eventLedger = {
      record: jest.fn(async () => ({}) as never),
      closeCase: jest.fn(async () => null),
    } as unknown as jest.Mocked<TransactionEventsService>;

    // Verdict et fait consigne partagent desormais une transaction SQL : le faux
    // manager execute le travail immediatement en reexposant le depot bouchonne.
    const dataSource = {
      transaction: async <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> =>
        work({ getRepository: () => repository } as unknown as EntityManager),
    } as unknown as DataSource;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: getRepositoryToken(Transaction), useValue: repository },
        { provide: TransactionEventsService, useValue: eventLedger },
        TransactionStateMachine,
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(ReconciliationService);
  });

  it('marque MATCHED et autorise alors seulement le scellement', async () => {
    const result = await service.reconcile(payment());

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.MATCHED);
    expect(result.reconciledAt).toBeInstanceOf(Date);
    expect(eventLedger.closeCase).toHaveBeenCalledTimes(1);
    // Le troisieme argument est la transaction SQL portant l'ecriture du verdict :
    // sa presence est ce qui garantit qu'un verdict ne peut pas survivre seul.
    expect(eventLedger.closeCase).toHaveBeenCalledWith(
      result,
      'Dossier clos apres rapprochement conforme',
      expect.anything(),
    );
  });

  it('consigne un ecart de montant mais laisse le dossier ouvert', async () => {
    const result = await service.reconcile(payment({ aggregatorAmount: 1250.76 }));

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.MISMATCH);
    expect(result.reconciliationReason).toContain('montant');
    // Le verdict est consigne — le litige est donc opposable — mais la cloture
    // n'a pas lieu : la dette subsiste tant qu'aucun remboursement n'aboutit.
    expect(eventLedger.record).toHaveBeenCalledTimes(1);
    expect(eventLedger.closeCase).not.toHaveBeenCalled();
  });

  it('repare une cloture manquante sans dupliquer le verdict lors d un rejeu', async () => {
    const alreadyMatched = payment({
      reconciliationStatus: ReconciliationStatus.MATCHED,
    });

    await service.reconcile(alreadyMatched);

    expect(eventLedger.record).not.toHaveBeenCalled();
    // La cloture est idempotente cote registre : la rappeler ne duplique rien.
    expect(eventLedger.closeCase).toHaveBeenCalledTimes(1);
  });

  it('laisse en attente une transaction dont la banque n a pas termine', async () => {
    const result = await service.reconcile(
      payment({ bankStatus: BankProcessingStatus.PROCESSING }),
    );

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.PENDING);
    expect(eventLedger.closeCase).not.toHaveBeenCalled();
  });
});

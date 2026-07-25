import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AnchorService } from '../blockchain/anchor.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import {
  BankProcessingStatus,
  MobileMoneyStatus,
  PaymentChannel,
  ReconciliationStatus,
} from './enums/mobile-money.enum';
import { ReconciliationService } from './reconciliation.service';

const payment = (overrides: Partial<Transaction> = {}): Transaction =>
  Object.assign(new Transaction(), {
    reference: 'TRF-20260725-8F3A2C71',
    paymentChannel: PaymentChannel.MOBILE_MONEY,
    status: TransactionStatus.COMPLETED,
    mobileMoneyStatus: MobileMoneyStatus.CONFIRMED,
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
  let anchor: jest.Mocked<AnchorService>;

  beforeEach(async () => {
    repository = {
      save: jest.fn(async (value: Transaction) => value),
      find: jest.fn(async () => []),
    } as unknown as jest.Mocked<Repository<Transaction>>;
    anchor = {
      sealTransaction: jest.fn(async (value: Transaction) => value),
    } as unknown as jest.Mocked<AnchorService>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: getRepositoryToken(Transaction), useValue: repository },
        { provide: AnchorService, useValue: anchor },
      ],
    }).compile();
    service = moduleRef.get(ReconciliationService);
  });

  it('marque MATCHED et autorise alors seulement le scellement', async () => {
    const result = await service.reconcile(payment());

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.MATCHED);
    expect(result.reconciledAt).toBeInstanceOf(Date);
    expect(anchor.sealTransaction).toHaveBeenCalledTimes(1);
  });

  it('detecte un ecart de montant sans sceller la transaction', async () => {
    const result = await service.reconcile(payment({ aggregatorAmount: 1250.76 }));

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.MISMATCH);
    expect(result.reconciliationReason).toContain('montant');
    expect(anchor.sealTransaction).not.toHaveBeenCalled();
  });

  it('laisse en attente une transaction dont la banque n a pas termine', async () => {
    const result = await service.reconcile(
      payment({ bankStatus: BankProcessingStatus.PROCESSING }),
    );

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.PENDING);
    expect(anchor.sealTransaction).not.toHaveBeenCalled();
  });
});

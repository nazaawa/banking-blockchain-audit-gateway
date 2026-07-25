import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditDirection, AuditOutcome } from '../audit/enums/audit-direction.enum';
import { businessConfig } from '../config/configuration';
import {
  SoapCommunicationException,
  SoapFaultException,
  SoapParsingException,
} from '../soap/exceptions/soap.exceptions';
import { SoapClientService } from '../soap/soap-client.service';
import type { AmountInWordsResult } from '../soap/soap.types';
import type { CreateTransferDto } from './dto/create-transfer.dto';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { ReferenceGenerator } from './reference.generator';
import { TransactionsRepository } from './transactions.repository';
import { MetricsService } from '../observability/metrics.service';
import { TransactionStateMachine } from './state/transaction-state.machine';
import { TransactionsService } from './transactions.service';
import { TransactionEventsService } from '../events/transaction-events.service';
import { TransactionEventType } from '../events/enums/transaction-event.enum';
import { TransferXmlBuilder } from '../xml/transfer-xml.builder';
import { XsdValidatorService } from '../xml/xsd-validator.service';

const DEBTOR_IBAN = 'FR7630006000011234567890189';
const CREDITOR_IBAN = 'DE89370400440532013000';
const REFERENCE = 'TRF-20260725-8F3A2C71';

const validDto = (overrides: Partial<CreateTransferDto> = {}): CreateTransferDto => ({
  debtorIban: DEBTOR_IBAN,
  debtorName: 'Societe Kongo SARL',
  creditorIban: CREDITOR_IBAN,
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
  endToEndLabel: 'Facture 2026-0042',
  ...overrides,
});

const soapSuccess = (): AmountInWordsResult => ({
  amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
  exchange: {
    operation: 'NumberToDollars',
    endpoint: 'https://www.dataaccess.com/webservicesserver/NumberConversion.wso',
    rawRequest:
      '<soap:Envelope><soap:Body><NumberToDollars><dNum>1250.75</dNum></NumberToDollars></soap:Body></soap:Envelope>',
    rawResponse: '<soap:Envelope><soap:Body><NumberToDollarsResponse/></soap:Body></soap:Envelope>',
    durationMs: 412,
    attempts: 1,
  },
});

describe('TransactionsService', () => {
  let service: TransactionsService;
  let repository: jest.Mocked<TransactionsRepository>;
  let soapClient: jest.Mocked<SoapClientService>;
  let auditService: jest.Mocked<AuditService>;
  let eventLedger: jest.Mocked<TransactionEventsService>;

  beforeEach(async () => {
    repository = {
      create: jest.fn((data: Partial<Transaction>) => {
        const entity = Object.assign(new Transaction(), data);
        entity.createdAt ??= new Date();
        entity.updatedAt ??= new Date();
        return entity;
      }),
      save: jest.fn(async (entity: Transaction) => entity),
      findByReference: jest.fn(async () => null),
      findByIdempotencyKey: jest.fn(async () => null),
      existsByReference: jest.fn(async () => false),
      paginate: jest.fn(async () => [[], 0]),
      isUniqueViolation: jest.fn(() => false),
    } as unknown as jest.Mocked<TransactionsRepository>;

    soapClient = {
      convertAmountToWords: jest.fn(async () => soapSuccess()),
    } as unknown as jest.Mocked<SoapClientService>;

    auditService = {
      record: jest.fn(async () => null),
      findByTransactionReference: jest.fn(async () => []),
    } as unknown as jest.Mocked<AuditService>;

    eventLedger = {
      record: jest.fn(async () => ({}) as never),
      closeCase: jest.fn(async () => null),
    } as unknown as jest.Mocked<TransactionEventsService>;

    // Ecriture metier et consignation du fait partagent une transaction SQL.
    // Le faux manager execute le travail sans differer : ce que les tests
    // eprouvent ici, c'est que les deux sont bien demandes ensemble.
    const dataSource = {
      transaction: async <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> =>
        work({} as EntityManager),
    } as unknown as DataSource;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        ReferenceGenerator,
        // Serialiseur et validateur reels : le chemin XML -> XSD est ainsi
        // reellement exerce par les tests du service.
        TransferXmlBuilder,
        XsdValidatorService,
        { provide: TransactionsRepository, useValue: repository },
        { provide: SoapClientService, useValue: soapClient },
        { provide: AuditService, useValue: auditService },
        { provide: TransactionEventsService, useValue: eventLedger },
        TransactionStateMachine,
        {
          provide: MetricsService,
          useValue: { soapDuration: { observe: jest.fn() } },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: businessConfig.KEY,
          useValue: { allowedCurrencies: ['EUR', 'USD'], maxAmount: 999_999_999.99 },
        },
      ],
    }).compile();

    service = moduleRef.get(TransactionsService);
  });

  // -------------------------------------------------------------------------

  describe('initiateTransfer — cas nominal', () => {
    it('enregistre la transaction, appelle le service SOAP et la marque COMPLETED', async () => {
      const transaction = await service.initiateTransfer(validDto());

      expect(transaction.status).toBe(TransactionStatus.COMPLETED);
      expect(transaction.amountInWords).toBe(
        'one thousand two hundred and fifty dollars and seventy five cents',
      );
      expect(transaction.reference).toMatch(/^TRF-\d{8}-[0-9A-HJ-NP-Z]{8}$/);
      expect(transaction.soapOperation).toBe('NumberToDollars');
      expect(transaction.soapDurationMs).toBe(412);
      expect(transaction.soapAttempts).toBe(1);
      expect(transaction.processedAt).toBeInstanceOf(Date);
      expect(soapClient.convertAmountToWords).toHaveBeenCalledWith(1250.75);
    });

    it('persiste la demande AVANT l appel externe', async () => {
      const callOrder: string[] = [];
      repository.save.mockImplementation(async (entity: Transaction) => {
        callOrder.push(`save:${entity.status}`);
        return entity;
      });
      soapClient.convertAmountToWords.mockImplementation(async () => {
        callOrder.push('soap');
        return soapSuccess();
      });

      await service.initiateTransfer(validDto());

      expect(callOrder).toEqual([
        `save:${TransactionStatus.PENDING}`,
        `save:${TransactionStatus.PROCESSING}`,
        'soap',
        `save:${TransactionStatus.COMPLETED}`,
      ]);
    });

    it('consigne le document canonique, la requete et la reponse dans la piste d audit', async () => {
      await service.initiateTransfer(validDto());

      expect(auditService.record).toHaveBeenCalledTimes(3);

      // Le document XML valide contre le XSD ouvre la piste : c'est la trace de
      // ce qui a effectivement franchi le contrat.
      expect(auditService.record).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          direction: AuditDirection.DOCUMENT_VALIDATED,
          outcome: AuditOutcome.SUCCESS,
          operation: 'transfer-request.xsd',
          rawPayload: expect.stringContaining('<TransferRequest'),
        }),
      );
      expect(auditService.record).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          direction: AuditDirection.OUTBOUND_REQUEST,
          outcome: AuditOutcome.SUCCESS,
          operation: 'NumberToDollars',
        }),
      );
      expect(auditService.record).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          direction: AuditDirection.INBOUND_RESPONSE,
          outcome: AuditOutcome.SUCCESS,
          durationMs: 412,
        }),
      );
    });

    it('consigne l ouverture puis l aboutissement dans le registre', async () => {
      const transaction = await service.initiateTransfer(validDto());

      const types = eventLedger.record.mock.calls.map((call) => call[0].type);
      expect(types).toEqual([
        TransactionEventType.TRANSFER_INITIATED,
        TransactionEventType.TRANSFER_COMPLETED,
      ]);
      // Le flux classique n a qu une jambe : l aboutissement clot le dossier.
      expect(eventLedger.closeCase).toHaveBeenCalledTimes(1);
      expect(transaction.status).toBe(TransactionStatus.COMPLETED);
    });

    it('consigne aussi l echec, et clot le dossier', async () => {
      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('injoignable', 'NumberToDollars', false),
      );

      await expect(service.initiateTransfer(validDto())).rejects.toThrow();

      const types = eventLedger.record.mock.calls.map((call) => call[0].type);
      expect(types).toContain(TransactionEventType.TRANSFER_FAILED);
      expect(eventLedger.closeCase).toHaveBeenCalledTimes(1);
    });

    it('conserve l IBAN complet en base — le masquage est une preoccupation de presentation', async () => {
      const transaction = await service.initiateTransfer(validDto());

      expect(transaction.debtorIban).toBe(DEBTOR_IBAN);
      expect(transaction.creditorIban).toBe(CREDITOR_IBAN);
    });
  });

  // -------------------------------------------------------------------------

  describe('initiateTransfer — regles metier', () => {
    it('refuse une devise absente de la liste autorisee', async () => {
      await expect(service.initiateTransfer(validDto({ currency: 'JPY' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
      expect(soapClient.convertAmountToWords).not.toHaveBeenCalled();
    });

    it('refuse un montant au-dela du plafond', async () => {
      await expect(service.initiateTransfer(validDto({ amount: 1_000_000_000 }))).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('refuse un virement d un compte vers lui-meme', async () => {
      await expect(
        service.initiateTransfer(validDto({ creditorIban: DEBTOR_IBAN })),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(soapClient.convertAmountToWords).not.toHaveBeenCalled();
    });

    it('expose un code d erreur stable', async () => {
      expect.assertions(1);
      try {
        await service.initiateTransfer(validDto({ currency: 'JPY' }));
      } catch (error) {
        expect((error as HttpException).getResponse()).toMatchObject({
          error: 'CURRENCY_NOT_ALLOWED',
        });
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('initiateTransfer — idempotence', () => {
    it('renvoie la transaction initiale sans rappeler le service externe', async () => {
      const existing = Object.assign(new Transaction(), {
        reference: REFERENCE,
        status: TransactionStatus.COMPLETED,
      });
      repository.findByIdempotencyKey.mockResolvedValue(existing);

      const result = await service.initiateTransfer(validDto(), 'cle-idempotence-001');

      expect(result).toBe(existing);
      expect(soapClient.convertAmountToWords).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('resout une course concurrente en renvoyant la transaction gagnante', async () => {
      const winner = Object.assign(new Transaction(), { reference: REFERENCE });
      repository.findByIdempotencyKey
        .mockResolvedValueOnce(null) // premiere verification : rien en base
        .mockResolvedValueOnce(winner); // apres la violation d unicite
      repository.save.mockRejectedValueOnce(new Error('duplicate key'));
      repository.isUniqueViolation.mockReturnValue(true);

      const result = await service.initiateTransfer(validDto(), 'cle-idempotence-002');

      expect(result).toBe(winner);
      expect(soapClient.convertAmountToWords).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('initiateTransfer — collision de reference', () => {
    it('rejoue la generation puis aboutit', async () => {
      repository.isUniqueViolation.mockReturnValue(true);
      repository.save
        .mockRejectedValueOnce(new Error('duplicate reference'))
        .mockImplementation(async (entity: Transaction) => entity);

      const transaction = await service.initiateTransfer(validDto());

      expect(transaction.status).toBe(TransactionStatus.COMPLETED);
      expect(repository.create).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------

  describe('initiateTransfer — echecs de l integration SOAP', () => {
    it('traduit une faute SOAP en 502 et marque la transaction FAILED', async () => {
      expect.assertions(6);

      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapFaultException(
          {
            soapVersion: '1.1',
            faultCode: 'soap:Server',
            faultString: 'Server was unable to process request.',
          },
          'NumberToDollars',
          '<soap:Fault/>',
        ),
      );

      try {
        await service.initiateTransfer(validDto());
      } catch (error) {
        expect(error).toBeInstanceOf(BadGatewayException);
        const payload = (error as HttpException).getResponse() as Record<string, unknown>;
        expect(payload.error).toBe('SOAP_FAULT');
        // La reference est renvoyee : la transaction reste consultable.
        expect(payload.reference).toMatch(/^TRF-/);
        expect(payload.details).toMatchObject({ faultCode: 'soap:Server' });
      }

      const saved = repository.save.mock.calls.at(-1)?.[0] as Transaction;
      expect(saved.status).toBe(TransactionStatus.FAILED);
      expect(saved.faultCode).toBe('soap:Server');
    });

    it('consigne la faute dans la piste d audit', async () => {
      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapFaultException(
          { soapVersion: '1.1', faultCode: 'soap:Server', faultString: 'boom' },
          'NumberToDollars',
        ),
      );

      await expect(service.initiateTransfer(validDto())).rejects.toThrow();

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: AuditDirection.INBOUND_FAULT,
          outcome: AuditOutcome.FAULT,
          faultCode: 'soap:Server',
        }),
      );
    });

    it('traduit un depassement de delai en 504', async () => {
      expect.assertions(2);

      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException(
          'timeout of 8000ms exceeded',
          'NumberToDollars',
          true,
          null,
          3,
        ),
      );

      try {
        await service.initiateTransfer(validDto());
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayTimeoutException);
        expect((error as HttpException).getResponse()).toMatchObject({ error: 'SOAP_TIMEOUT' });
      }
    });

    it('traduit une indisponibilite reseau en 502', async () => {
      expect.assertions(2);

      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapCommunicationException('getaddrinfo ENOTFOUND', 'NumberToDollars', false),
      );

      try {
        await service.initiateTransfer(validDto());
      } catch (error) {
        expect(error).toBeInstanceOf(BadGatewayException);
        expect((error as HttpException).getResponse()).toMatchObject({
          error: 'SOAP_UNAVAILABLE',
        });
      }
    });

    it('traduit une reponse inexploitable en 502 sans divulguer le detail technique', async () => {
      expect.assertions(2);

      soapClient.convertAmountToWords.mockRejectedValue(
        new SoapParsingException('Reponse XML malformee : sax error at line 3', 'NumberToDollars'),
      );

      try {
        await service.initiateTransfer(validDto());
      } catch (error) {
        const payload = (error as HttpException).getResponse() as Record<string, unknown>;
        expect(payload.error).toBe('SOAP_INVALID_RESPONSE');
        expect(JSON.stringify(payload)).not.toContain('sax error');
      }
    });

    it('marque la transaction FAILED meme sur une erreur inattendue', async () => {
      soapClient.convertAmountToWords.mockRejectedValue(new Error('panne inattendue'));

      await expect(service.initiateTransfer(validDto())).rejects.toThrow();

      const saved = repository.save.mock.calls.at(-1)?.[0] as Transaction;
      expect(saved.status).toBe(TransactionStatus.FAILED);
      expect(saved.failureReason).toBe('Erreur interne pendant le traitement');
    });
  });

  // -------------------------------------------------------------------------

  describe('findByReference', () => {
    it('retourne la transaction demandee', async () => {
      const transaction = Object.assign(new Transaction(), { reference: REFERENCE });
      repository.findByReference.mockResolvedValue(transaction);

      await expect(service.findByReference(REFERENCE)).resolves.toBe(transaction);
    });

    it('leve une 404 pour une reference inconnue', async () => {
      await expect(service.findByReference(REFERENCE)).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------

  describe('list', () => {
    it('calcule le nombre de pages et masque les IBAN', async () => {
      const transaction = Object.assign(new Transaction(), {
        reference: REFERENCE,
        status: TransactionStatus.COMPLETED,
        debtorIban: DEBTOR_IBAN,
        creditorIban: CREDITOR_IBAN,
        creditorName: 'ACME GmbH',
        amount: 1250.75,
        currency: 'EUR',
        correlationId: 'corr-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repository.paginate.mockResolvedValue([[transaction], 137]);

      const result = await service.list({ page: 2, limit: 20 });

      expect(result.total).toBe(137);
      expect(result.pages).toBe(7);
      expect(result.items[0].debtorIbanMasked).toBe('FR76****0189');
      expect(JSON.stringify(result)).not.toContain(DEBTOR_IBAN);
    });
  });

  // -------------------------------------------------------------------------

  describe('getAuditTrail', () => {
    it('verifie l existence de la transaction avant de retourner la piste', async () => {
      await expect(service.getAuditTrail(REFERENCE)).rejects.toThrow(NotFoundException);
      expect(auditService.findByTransactionReference).not.toHaveBeenCalled();
    });

    it('retourne les entrees d audit de la transaction', async () => {
      repository.findByReference.mockResolvedValue(
        Object.assign(new Transaction(), { reference: REFERENCE }),
      );

      await service.getAuditTrail(REFERENCE);

      expect(auditService.findByTransactionReference).toHaveBeenCalledWith(REFERENCE);
    });
  });
});

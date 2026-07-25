import type { CreateTransferDto } from '../transactions/dto/create-transfer.dto';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { RECORD_FORMAT_VERSION, TransferXmlBuilder } from './transfer-xml.builder';
import { SCHEMAS, XsdValidatorService } from './xsd-validator.service';

const dto = (overrides: Partial<CreateTransferDto> = {}): CreateTransferDto => ({
  debtorIban: 'FR7630006000011234567890189',
  debtorName: 'Societe Kongo SARL',
  creditorIban: 'DE89370400440532013000',
  creditorName: 'ACME GmbH',
  amount: 1250.75,
  currency: 'EUR',
  endToEndLabel: 'Facture 2026-0042',
  ...overrides,
});

const transaction = (overrides: Partial<Transaction> = {}): Transaction =>
  Object.assign(new Transaction(), {
    reference: 'TRF-20260725-8F3A2C71',
    status: TransactionStatus.COMPLETED,
    debtorIban: 'FR7630006000011234567890189',
    debtorName: 'Societe Kongo SARL',
    creditorIban: 'DE89370400440532013000',
    creditorName: 'ACME GmbH',
    amount: 1250.75,
    currency: 'EUR',
    endToEndLabel: 'Facture 2026-0042',
    amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
    soapOperation: 'NumberToDollars',
    soapDurationMs: 412,
    soapAttempts: 1,
    faultCode: null,
    faultString: null,
    correlationId: 'b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77',
    createdAt: new Date('2026-07-25T10:12:33.415Z'),
    processedAt: new Date('2026-07-25T10:12:33.827Z'),
    ...overrides,
  });

describe('TransferXmlBuilder', () => {
  const builder = new TransferXmlBuilder();
  const validator = new XsdValidatorService();

  describe('buildTransferRequest', () => {
    it('produit un document conforme a transfer-request.xsd', async () => {
      const xml = builder.buildTransferRequest(dto());
      await expect(validator.validate(xml, SCHEMAS.transferRequest)).resolves.toEqual([]);
    });

    it('omet les elements optionnels absents plutot que d emettre des balises vides', () => {
      const xml = builder.buildTransferRequest(
        dto({ debtorName: undefined, endToEndLabel: undefined }),
      );

      expect(xml).not.toContain('debtorName');
      expect(xml).not.toContain('endToEndLabel');
    });

    it('formate toujours le montant avec deux decimales', () => {
      expect(builder.buildTransferRequest(dto({ amount: 1250.7 }))).toContain(
        '<amount>1250.70</amount>',
      );
      expect(builder.buildTransferRequest(dto({ amount: 42 }))).toContain('<amount>42.00</amount>');
    });
  });

  describe('buildTransferRecord', () => {
    it('produit un document conforme a transfer-record.xsd', async () => {
      const xml = builder.buildTransferRecord(transaction());
      await expect(validator.validate(xml, SCHEMAS.transferRecord)).resolves.toEqual([]);
    });

    it('scelle aussi une transaction en echec, avec le motif du rejet', async () => {
      const xml = builder.buildTransferRecord(
        transaction({
          status: TransactionStatus.FAILED,
          amountInWords: null,
          faultCode: 'soap:Server',
          faultString: 'Server was unable to process request.',
        }),
      );

      await expect(validator.validate(xml, SCHEMAS.transferRecord)).resolves.toEqual([]);
      expect(xml).toContain('<faultCode>soap:Server</faultCode>');
    });

    it('refuse de sceller une transaction non terminale', () => {
      expect(() => builder.buildTransferRecord(transaction({ processedAt: null }))).toThrow(
        /etat terminal/,
      );
    });

    it('porte la version du format de scellement', () => {
      expect(builder.buildTransferRecord(transaction())).toContain(
        `version="${RECORD_FORMAT_VERSION}"`,
      );
    });
  });

  describe('canonicite', () => {
    it('est strictement deterministe', () => {
      const first = builder.buildTransferRecord(transaction());
      const second = builder.buildTransferRecord(transaction());

      expect(first).toBe(second);
    });

    it('reste identique quel que soit l ordre de construction de l objet', () => {
      // Les proprietes JavaScript sont ordonnees : le serialiseur ne doit pas
      // en dependre, sous peine d empreintes divergentes.
      const reference = builder.buildTransferRecord(transaction());
      const shuffled = Object.assign(new Transaction(), {
        processedAt: new Date('2026-07-25T10:12:33.827Z'),
        currency: 'EUR',
        reference: 'TRF-20260725-8F3A2C71',
        amount: 1250.75,
        creditorName: 'ACME GmbH',
        status: TransactionStatus.COMPLETED,
        creditorIban: 'DE89370400440532013000',
        debtorName: 'Societe Kongo SARL',
        debtorIban: 'FR7630006000011234567890189',
        soapAttempts: 1,
        endToEndLabel: 'Facture 2026-0042',
        amountInWords: 'one thousand two hundred and fifty dollars and seventy five cents',
        soapDurationMs: 412,
        soapOperation: 'NumberToDollars',
        faultCode: null,
        faultString: null,
        createdAt: new Date('2026-07-25T10:12:33.415Z'),
        correlationId: 'b6f0c4a2-6a5f-4a13-9d2e-3f0c9e2a1b77',
      }) as Transaction;

      expect(builder.buildTransferRecord(shuffled)).toBe(reference);
    });

    it('normalise 1250.7 et 1250.70 vers le meme document', () => {
      expect(builder.buildTransferRecord(transaction({ amount: 1250.7 }))).toBe(
        builder.buildTransferRecord(transaction({ amount: 1250.7 })),
      );
    });

    it('serialise les dates en ISO 8601 UTC', () => {
      expect(builder.buildTransferRecord(transaction())).toContain(
        '<processedAt>2026-07-25T10:12:33.827Z</processedAt>',
      );
    });
  });

  describe('securite', () => {
    it('neutralise une tentative d injection XML dans un nom de partie', async () => {
      const hostile = transaction({
        creditorName: '</name></creditor><amount>0.01</amount><!--',
      });

      const xml = builder.buildTransferRecord(hostile);

      // La charge est echappee : elle ne peut pas restructurer le document,
      // donc pas davantage detourner l empreinte scellee.
      expect(xml).toContain('&lt;/name&gt;&lt;/creditor&gt;');
      expect(xml).not.toContain('</name></creditor><amount>0.01</amount>');
      await expect(validator.validate(xml, SCHEMAS.transferRecord)).resolves.toEqual([]);
    });

    it('echappe les esperluettes, guillemets et apostrophes', () => {
      const xml = builder.buildTransferRecord(transaction({ creditorName: `A & B "C" D'E` }));

      expect(xml).toContain('A &amp; B &quot;C&quot; D&apos;E');
    });
  });
});

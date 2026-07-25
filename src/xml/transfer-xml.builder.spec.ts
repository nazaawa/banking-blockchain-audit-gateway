import type { CreateTransferDto } from '../transactions/dto/create-transfer.dto';
import { TransferXmlBuilder } from './transfer-xml.builder';
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

    it('est strictement deterministe', () => {
      expect(builder.buildTransferRequest(dto())).toBe(builder.buildTransferRequest(dto()));
    });

    it('neutralise une injection XML dans un nom de partie', () => {
      const xml = builder.buildTransferRequest(dto({ creditorName: 'A & B' }));

      expect(xml).toContain('A &amp; B');
    });
  });
});

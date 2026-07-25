import { Injectable } from '@nestjs/common';
import type { CreateTransferDto } from '../transactions/dto/create-transfer.dto';
import type { Transaction } from '../transactions/entities/transaction.entity';

/** Espace de noms des documents metier de la passerelle. */
export const TRANSFER_NAMESPACE = 'urn:banking:transfer:1.0';

/**
 * Version du format de scellement.
 *
 * Toute modification de la serialisation (ordre, indentation, formatage des
 * nombres) change les empreintes. L'incrementer permet de conserver un
 * serialiseur historique pour rejouer la verification d'archives anciennes.
 */
export const RECORD_FORMAT_VERSION = '1.0';

/** Indentation fixe : elle fait partie du document canonique. */
const INDENT = '  ';

/**
 * Serialise les documents XML metier de la passerelle.
 *
 * ## Canonicite
 *
 * L'empreinte ancree sur la blockchain porte sur les octets exacts du document.
 * Deux serialisations de la meme transaction doivent donc produire exactement
 * la meme chaine, aujourd'hui comme dans cinq ans.
 *
 * Plutot que d'appliquer une canonicalisation XML (C14N) apres coup, ce
 * serialiseur est deterministe par construction : ordre des elements impose par
 * le XSD, indentation fixe, fins de ligne LF, formatage numerique explicite,
 * dates en ISO 8601 UTC. Aucun element optionnel vide n'est emis — sa presence
 * ou son absence est donc, elle aussi, deterministe.
 */
@Injectable()
export class TransferXmlBuilder {
  /**
   * Document de demande, valide contre `transfer-request.xsd` avant l'appel au
   * back-office SOAP.
   */
  buildTransferRequest(dto: CreateTransferDto): string {
    const body = [
      this.element('debtorIban', dto.debtorIban, 1),
      this.optionalElement('debtorName', dto.debtorName, 1),
      this.element('creditorIban', dto.creditorIban, 1),
      this.element('creditorName', dto.creditorName, 1),
      this.element('amount', this.formatAmount(dto.amount), 1),
      this.element('currency', dto.currency, 1),
      this.optionalElement('endToEndLabel', dto.endToEndLabel, 1),
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<TransferRequest xmlns="${TRANSFER_NAMESPACE}">`,
      body,
      '</TransferRequest>',
    ].join('\n');
  }

  /**
   * Document scelle, valide contre `transfer-record.xsd` puis hache.
   *
   * @throws Error si la transaction n'est pas dans un etat terminal — une
   *         transaction encore en cours changerait d'empreinte.
   */
  buildTransferRecord(transaction: Transaction): string {
    if (transaction.processedAt === null) {
      throw new Error(
        `La transaction ${transaction.reference} n'est pas dans un etat terminal : ` +
          `elle ne peut pas etre scellee.`,
      );
    }

    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<TransferRecord xmlns="${TRANSFER_NAMESPACE}" version="${RECORD_FORMAT_VERSION}">`,
      this.element('reference', transaction.reference, 1),
      this.element('status', transaction.status, 1),
      `${INDENT}<debtor>`,
      this.element('iban', transaction.debtorIban, 2),
      this.optionalElement('name', transaction.debtorName, 2),
      `${INDENT}</debtor>`,
      `${INDENT}<creditor>`,
      this.element('iban', transaction.creditorIban, 2),
      this.optionalElement('name', transaction.creditorName, 2),
      `${INDENT}</creditor>`,
      this.element('amount', this.formatAmount(Number(transaction.amount)), 1),
      this.element('currency', transaction.currency, 1),
      this.optionalElement('endToEndLabel', transaction.endToEndLabel, 1),
      `${INDENT}<soap>`,
      this.optionalElement('operation', transaction.soapOperation, 2),
      this.optionalElement('durationMs', this.formatInteger(transaction.soapDurationMs), 2),
      this.optionalElement('attempts', this.formatInteger(transaction.soapAttempts), 2),
      this.optionalElement('amountInWords', transaction.amountInWords, 2),
      this.optionalElement('faultCode', transaction.faultCode, 2),
      this.optionalElement('faultString', transaction.faultString, 2),
      `${INDENT}</soap>`,
      this.element('correlationId', transaction.correlationId, 1),
      this.element('createdAt', this.formatDate(transaction.createdAt), 1),
      this.element('processedAt', this.formatDate(transaction.processedAt), 1),
      '</TransferRecord>',
    ];

    return lines.filter((line): line is string => line !== null).join('\n');
  }

  // -------------------------------------------------------------------------

  private element(name: string, value: string, depth: number): string {
    return `${INDENT.repeat(depth)}<${name}>${this.escape(value)}</${name}>`;
  }

  /** Un element optionnel vide est omis, jamais emis sous forme de balise vide. */
  private optionalElement(
    name: string,
    value: string | null | undefined,
    depth: number,
  ): string | null {
    if (value === null || value === undefined || value === '') return null;
    return this.element(name, value, depth);
  }

  /**
   * Echappement XML.
   *
   * Double role : conformite du document, et neutralisation d'une injection —
   * un nom de beneficiaire contenant `</creditorName>` ne doit pas pouvoir
   * restructurer le document ni, par ricochet, l'empreinte scellee.
   */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** Toujours 2 decimales : `1250.7` et `1250.70` doivent donner le meme octet. */
  private formatAmount(amount: number): string {
    return amount.toFixed(2);
  }

  private formatInteger(value: number | null): string | null {
    return value === null || value === undefined ? null : String(Math.trunc(value));
  }

  /** ISO 8601 UTC avec millisecondes : format unique et sans ambiguite de fuseau. */
  private formatDate(date: Date): string {
    return date.toISOString();
  }
}

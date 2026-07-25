import { Injectable } from '@nestjs/common';
import type { TransactionEvent } from './entities/transaction-event.entity';

export const EVENT_NAMESPACE = 'urn:banking:event:1.0';

/**
 * Version du format de scellement des evenements.
 *
 * Independante de celle des enregistrements de transaction : les deux documents
 * evolueront a des rythmes differents, et melanger leurs versions rendrait la
 * verification d'archives ambigue.
 */
export const EVENT_RECORD_FORMAT_VERSION = '2.1';

const INDENT = '  ';

/** Donnees d'un evenement avant insertion : l'empreinte porte sur elles. */
export type SerializableEvent = Omit<
  TransactionEvent,
  | 'id'
  | 'fingerprint'
  | 'fingerprintSalt'
  | 'recordFormatVersion'
  | 'anchorStatus'
  | 'batchId'
  | 'leafIndex'
  | 'merkleProof'
  | 'createdAt'
  // Metadonnee de persistance : le format de chiffrement decrit comment la
  // ligne est stockee, pas ce qui s'est produit. L'inclure ferait dependre une
  // empreinte metier d'un detail d'infrastructure.
  | 'encryptionVersion'
> & { id: string; recordFormatVersion?: string };

/**
 * Serialise un fait metier en document canonique.
 *
 * Meme discipline que `TransferXmlBuilder` : deterministe par construction —
 * ordre impose par le XSD, indentation fixe, montants a 2 decimales, dates ISO
 * 8601 UTC, elements optionnels vides omis. C'est ce qui permet de recalculer
 * l'empreinte a l'identique des annees plus tard.
 */
@Injectable()
export class TransactionEventXmlBuilder {
  build(event: SerializableEvent): string {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<TransactionEvent xmlns="${EVENT_NAMESPACE}" version="${
        event.recordFormatVersion ?? EVENT_RECORD_FORMAT_VERSION
      }">`,
      this.element('eventId', event.id, 1),
      this.element('eventType', event.eventType, 1),
      this.element('sequence', String(event.sequence), 1),
      this.element('transactionReference', event.transactionReference, 1),
      this.optionalElement('providerReference', event.providerReference, 1),
      this.optionalElement('bankReference', event.bankReference, 1),

      `${INDENT}<statuses>`,
      this.optionalElement('provider', event.providerStatus, 2),
      this.optionalElement('bank', event.bankStatus, 2),
      this.optionalElement('reconciliation', event.reconciliationStatus, 2),
      this.optionalElement('refund', event.refundStatus, 2),
      this.optionalElement('case', event.caseStatus, 2),
      `${INDENT}</statuses>`,

      `${INDENT}<amounts>`,
      this.element('expected', this.formatAmount(Number(event.expectedAmount)), 2),
      this.element('currency', event.currency, 2),
      this.optionalElement(
        'observed',
        event.observedAmount === null || event.observedAmount === undefined
          ? null
          : this.formatAmount(Number(event.observedAmount)),
        2,
      ),
      this.optionalElement('observedCurrency', event.observedCurrency, 2),
      `${INDENT}</amounts>`,

      this.element('occurredAt', this.formatDate(event.occurredAt), 1),
      this.element('correlationId', event.correlationId, 1),
      this.optionalElement('detail', event.detail, 1),
      ...(event.actorId && event.actorRole && event.actionOrigin
        ? [
            `${INDENT}<actor>`,
            this.element('actorId', event.actorId, 2),
            this.element('actorRole', event.actorRole, 2),
            this.element('actionOrigin', event.actionOrigin, 2),
            `${INDENT}</actor>`,
          ]
        : []),
      this.optionalElement('previousFingerprint', event.previousFingerprint, 1),

      // Bloc present sur le seul evenement de cloture. Les autres documents
      // restent serialises a l'identique : aucune empreinte anterieure ne bouge.
      ...(event.closureEventCount !== null &&
      event.closureEventCount !== undefined &&
      event.closureChainHead
        ? [
            `${INDENT}<closure>`,
            this.element('eventCount', String(event.closureEventCount), 2),
            this.element('chainHead', event.closureChainHead, 2),
            `${INDENT}</closure>`,
          ]
        : []),
      // Bloc present sur le seul evenement d'ouverture.
      ...(event.debtorIban && event.creditorIban
        ? [
            `${INDENT}<parties>`,
            this.element('debtorIban', event.debtorIban, 2),
            this.optionalElement('debtorName', event.debtorName, 2),
            this.element('creditorIban', event.creditorIban, 2),
            this.element('creditorName', event.creditorName ?? '', 2),
            this.optionalElement('endToEndLabel', event.endToEndLabel, 2),
          ]
            .filter((line): line is string => line !== null)
            .concat(`${INDENT}</parties>`)
        : []),
      '</TransactionEvent>',
    ];

    return lines.filter((line): line is string => line !== null).join('\n');
  }

  private element(name: string, value: string, depth: number): string {
    return `${INDENT.repeat(depth)}<${name}>${this.escape(value)}</${name}>`;
  }

  private optionalElement(
    name: string,
    value: string | null | undefined,
    depth: number,
  ): string | null {
    if (value === null || value === undefined || value === '') return null;
    return this.element(name, value, depth);
  }

  /** Neutralise toute tentative de restructurer le document par une valeur. */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private formatAmount(amount: number): string {
    return amount.toFixed(2);
  }

  private formatDate(date: Date): string {
    return date.toISOString();
  }
}

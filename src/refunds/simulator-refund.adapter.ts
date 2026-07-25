import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  ProviderRefundRejectedException,
  ProviderRefundUnavailableException,
  type ProviderRefundPort,
  type ProviderRefundResult,
} from './provider-refund.port';

/**
 * Adaptateur de remboursement du simulateur d'agregateur.
 *
 * Deduplique sur la cle d'idempotence, comme le ferait un vrai fournisseur :
 * c'est precisement ce comportement qui rend la reprise sure cote passerelle,
 * et un simulateur qui ne le reproduirait pas donnerait une fausse assurance.
 *
 * Deux leviers permettent d'eprouver les chemins d'echec sans bricoler le code :
 * un montant se terminant par `.13` declenche un refus metier, un montant se
 * terminant par `.99` une indisponibilite.
 */
@Injectable()
export class SimulatorRefundAdapter implements ProviderRefundPort {
  private readonly logger = new Logger(SimulatorRefundAdapter.name);
  private readonly processed = new Map<string, string>();

  refund(request: {
    idempotencyKey: string;
    providerReference: string;
    amount: number;
    currency: string;
  }): Promise<ProviderRefundResult> {
    const alreadyDone = this.processed.get(request.idempotencyKey);
    if (alreadyDone) {
      this.logger.log({
        event: 'simulator.refund.deduplicated',
        idempotencyKey: request.idempotencyKey,
        providerRefundReference: alreadyDone,
      });
      return Promise.resolve({ providerRefundReference: alreadyDone, deduplicated: true });
    }

    const cents = Math.round(request.amount * 100) % 100;
    if (cents === 13) {
      return Promise.reject(new ProviderRefundRejectedException('Solde marchand insuffisant'));
    }
    if (cents === 99) {
      return Promise.reject(new ProviderRefundUnavailableException('Delai d attente depasse'));
    }

    const reference = `RFN-${randomBytes(6).toString('hex').toUpperCase()}`;
    this.processed.set(request.idempotencyKey, reference);

    this.logger.log({
      event: 'simulator.refund.accepted',
      providerReference: request.providerReference,
      amount: request.amount,
      currency: request.currency,
      providerRefundReference: reference,
    });

    return Promise.resolve({ providerRefundReference: reference, deduplicated: false });
  }
}

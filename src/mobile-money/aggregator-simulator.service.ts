import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Transaction } from '../transactions/entities/transaction.entity';
import { MobileMoneyWebhookDto, MobileMoneyWebhookStatus } from './dto/mobile-money-webhook.dto';
import type { SimulateMobileMoneyDto } from './dto/simulate-mobile-money.dto';

/** Simulateur local du contrat minimal d'un agregateur Mobile Money. */
@Injectable()
export class AggregatorSimulatorService {
  generateReference(now = new Date()): string {
    return `AGG-${this.date(now)}-${randomBytes(6).toString('hex').toUpperCase()}`;
  }

  buildWebhook(
    transaction: Transaction,
    input: SimulateMobileMoneyDto,
    now = new Date(),
  ): MobileMoneyWebhookDto {
    return {
      eventId: `EVT-${this.date(now)}-${randomBytes(6).toString('hex').toUpperCase()}`,
      aggregatorReference: transaction.aggregatorReference as string,
      status: input.status ?? MobileMoneyWebhookStatus.CONFIRMED,
      amount: input.amount ?? Number(transaction.amount),
      currency: (input.currency ?? transaction.currency).trim().toUpperCase(),
      occurredAt: now.toISOString(),
      failureReason:
        (input.status ?? MobileMoneyWebhookStatus.CONFIRMED) === MobileMoneyWebhookStatus.FAILED
          ? 'Paiement refuse par le simulateur'
          : undefined,
    };
  }

  private date(value: Date): string {
    return value.toISOString().slice(0, 10).replace(/-/g, '');
  }
}

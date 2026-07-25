import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { auditConfig } from '../config/configuration';
import { getCorrelationId } from '../common/context/request-context';
import { maskXml, truncate } from '../common/utils/masking.util';
import { AuditLog } from './entities/audit-log.entity';
import { AuditDirection, AuditOutcome } from './enums/audit-direction.enum';

export interface AuditEntryInput {
  direction: AuditDirection;
  outcome: AuditOutcome;
  operation: string;
  transactionReference?: string | null;
  correlationId?: string;
  endpoint?: string | null;
  /** XML brut : il est masque et tronque par le service avant persistance. */
  rawPayload?: string | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  faultCode?: string | null;
  faultString?: string | null;
  message?: string | null;
}

/**
 * Journalisation des echanges SOAP.
 *
 * Deux garanties :
 *  1. **Confidentialite** — tout payload est passe par `maskXml` puis tronque
 *     avant d'etre persiste ; la retention peut etre coupee entierement via
 *     `AUDIT_PERSIST_PAYLOADS=false`.
 *  2. **Non-blocage** — un echec d'ecriture d'audit ne fait jamais echouer la
 *     transaction metier : il est journalise et absorbe.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repository: Repository<AuditLog>,
    @Inject(auditConfig.KEY)
    private readonly config: ConfigType<typeof auditConfig>,
  ) {}

  /** Consigne un echange. N'echoue jamais : retourne `null` en cas de probleme. */
  async record(entry: AuditEntryInput): Promise<AuditLog | null> {
    try {
      const log = this.repository.create({
        correlationId: entry.correlationId ?? getCorrelationId(),
        transactionReference: entry.transactionReference ?? null,
        direction: entry.direction,
        outcome: entry.outcome,
        operation: entry.operation,
        endpoint: entry.endpoint ?? null,
        payload: this.preparePayload(entry.rawPayload),
        payloadBytes: entry.rawPayload ? Buffer.byteLength(entry.rawPayload, 'utf8') : null,
        httpStatus: entry.httpStatus ?? null,
        durationMs: entry.durationMs ?? null,
        faultCode: entry.faultCode ?? null,
        faultString: this.clamp(entry.faultString, 1024),
        message: this.clamp(entry.message, 1024),
      });

      return await this.repository.save(log);
    } catch (error) {
      this.logger.error({
        event: 'audit.persist.failed',
        correlationId: entry.correlationId ?? getCorrelationId(),
        operation: entry.operation,
        reason: error instanceof Error ? error.message : 'erreur inconnue',
      });
      return null;
    }
  }

  /** Piste d'audit complete d'une transaction, du plus ancien au plus recent. */
  async findByTransactionReference(reference: string): Promise<AuditLog[]> {
    return this.repository.find({
      where: { transactionReference: reference },
      order: { createdAt: 'ASC' },
    });
  }

  /** Applique masquage puis troncature. Retourne `null` si la retention est desactivee. */
  private preparePayload(rawPayload?: string | null): string | null {
    if (!rawPayload || !this.config.persistPayloads) return null;
    return truncate(maskXml(rawPayload), this.config.maxPayloadChars);
  }

  private clamp(value: string | null | undefined, max: number): string | null {
    if (!value) return null;
    return value.length <= max ? value : value.slice(0, max);
  }
}

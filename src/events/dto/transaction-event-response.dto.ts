import { OmitType } from '@nestjs/swagger';
import { TransactionEvent } from '../entities/transaction-event.entity';

/**
 * Vue publique d'un fait.
 *
 * Le sel permet de recalculer l'empreinte mais ne doit jamais quitter la base :
 * le publier reduirait la resistance de la preuve aux attaques par dictionnaire.
 */
export class TransactionEventResponseDto extends OmitType(TransactionEvent, [
  'fingerprintSalt',
] as const) {
  static fromEntity(event: TransactionEvent): TransactionEventResponseDto {
    const { fingerprintSalt: _fingerprintSalt, ...safe } = event;
    return Object.assign(new TransactionEventResponseDto(), safe);
  }
}

import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { maskIban } from '../../common/utils/masking.util';
import { TransactionEvent } from '../entities/transaction-event.entity';

/**
 * Vue publique d'un fait.
 *
 * Deux categories ne franchissent jamais la surface HTTP :
 *
 * - **le sel** — il permet de recalculer l'empreinte ; le publier reduirait la
 *   resistance de la preuve aux attaques par dictionnaire ;
 * - **les IBAN de l'ouverture** — le registre les consigne en clair parce que
 *   c'est contre eux que la verification confronte la ligne courante, mais la
 *   regle vaut ici comme partout ailleurs : le stockage conserve, l'API masque.
 */
export class TransactionEventResponseDto extends OmitType(TransactionEvent, [
  'fingerprintSalt',
  'debtorIban',
  'creditorIban',
] as const) {
  @ApiPropertyOptional({
    example: 'FR76****0189',
    nullable: true,
    description: 'IBAN du donneur d ordre, masque. Renseigne sur le seul fait d ouverture.',
  })
  debtorIbanMasked!: string | null;

  @ApiPropertyOptional({
    example: 'DE89****3000',
    nullable: true,
    description: 'IBAN du beneficiaire, masque. Renseigne sur le seul fait d ouverture.',
  })
  creditorIbanMasked!: string | null;

  static fromEntity(event: TransactionEvent): TransactionEventResponseDto {
    const { fingerprintSalt: _fingerprintSalt, debtorIban, creditorIban, ...safe } = event;

    return Object.assign(new TransactionEventResponseDto(), safe, {
      debtorIbanMasked: debtorIban === null ? null : maskIban(debtorIban),
      creditorIbanMasked: creditorIban === null ? null : maskIban(creditorIban),
    });
  }
}

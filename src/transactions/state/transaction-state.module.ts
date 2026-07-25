import { Global, Module } from '@nestjs/common';
import { TransactionStateMachine } from './transaction-state.machine';

/**
 * Machine a etats partagee.
 *
 * Le module est global parce que la regle doit etre la meme partout : chaque
 * flux qui fait evoluer une transaction — virement classique, Mobile Money,
 * rapprochement, remboursement — passe par la meme table de transitions. Laisser
 * chaque module fournir la sienne ouvrirait la porte a des regles divergentes,
 * ce qui viderait la garantie de son sens.
 *
 * Le service est sans etat : l'instance unique n'est pas un partage de donnees.
 */
@Global()
@Module({
  providers: [TransactionStateMachine],
  exports: [TransactionStateMachine],
})
export class TransactionStateModule {}

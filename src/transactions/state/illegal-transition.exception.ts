/**
 * Transition refusee par la machine a etats.
 *
 * Ce n'est pas une erreur d'integration : les courses entre notifications sont
 * deja tranchees par des mises a jour conditionnelles, qui ne franchissent
 * simplement pas leur predicat. Une transition refusee signale donc un defaut
 * de la passerelle elle-meme, et doit remonter comme tel plutot que d'etre
 * traduite en reponse metier.
 */
export class IllegalTransitionException extends Error {
  constructor(
    readonly reference: string,
    readonly violations: readonly string[],
  ) {
    super(`Transition refusee pour ${reference} : ${violations.join(' | ')}`);
    this.name = 'IllegalTransitionException';
  }
}

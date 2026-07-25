import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Dispense une route de l'authentification par cle.
 *
 * A n'employer que si la route porte sa propre authentification (le webhook
 * agregateur est signe en HMAC) ou n'expose aucune donnee (sonde de sante).
 * La politique par defaut est le refus : oublier ce decorateur ferme une route,
 * l'oublier dans l'autre sens l'ouvrirait.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

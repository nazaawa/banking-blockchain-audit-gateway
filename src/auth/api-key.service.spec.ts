import { createHash, randomBytes } from 'node:crypto';
import { ApiKeyService } from './api-key.service';
import { SCOPES } from './scopes';

const hashOf = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

const build = (apiKeys: string[], enabled = true): ApiKeyService => {
  const service = new ApiKeyService({ enabled, apiKeys });
  service.onModuleInit();
  return service;
};

const SECRET = 'un-secret-de-test-suffisamment-long';
const ENTRY = `ops|${hashOf(SECRET)}|${SCOPES.transfersRead},${SCOPES.refundsWrite}|Exploitation`;

describe('ApiKeyService', () => {
  describe('authentification', () => {
    it('accepte une cle valide et restitue ses habilitations', () => {
      const identity = build([ENTRY]).authenticate(`Bearer ops.${SECRET}`);

      expect(identity).toMatchObject({
        keyId: 'ops',
        label: 'Exploitation',
        scopes: [SCOPES.transfersRead, SCOPES.refundsWrite],
      });
    });

    it('accepte quelle que soit la casse du schema', () => {
      expect(build([ENTRY]).authenticate(`bearer ops.${SECRET}`)).not.toBeNull();
      expect(build([ENTRY]).authenticate(`BEARER ops.${SECRET}`)).not.toBeNull();
    });

    it.each([
      ['en-tete absent', undefined],
      ['en-tete vide', ''],
      ['schema absent', `ops.${SECRET}`],
      ['schema inconnu', `Basic ops.${SECRET}`],
      ['sans separateur', 'Bearer opsSECRET'],
      ['identifiant vide', `Bearer .${SECRET}`],
      ['secret vide', 'Bearer ops.'],
      ['identifiant inconnu', `Bearer autre.${SECRET}`],
      ['secret errone', 'Bearer ops.mauvais-secret'],
    ])('refuse : %s', (_cas, header) => {
      expect(build([ENTRY]).authenticate(header)).toBeNull();
    });

    it('refuse un secret dont seul le prefixe est correct', () => {
      expect(build([ENTRY]).authenticate(`Bearer ops.${SECRET.slice(0, -1)}`)).toBeNull();
    });

    it('conserve un secret contenant des points', () => {
      // Le premier point separe identifiant et secret ; les suivants
      // appartiennent au secret.
      const secret = 'avec.des.points';
      const service = build([`ops|${hashOf(secret)}|${SCOPES.transfersRead}|Ops`]);

      expect(service.authenticate(`Bearer ops.${secret}`)).not.toBeNull();
    });
  });

  describe('chargement de la configuration', () => {
    it('ignore une entree sans empreinte valide', () => {
      const service = build(['ops|pas-un-hash|transfers:read|Ops']);
      expect(service.authenticate(`Bearer ops.${SECRET}`)).toBeNull();
    });

    it('ignore une entree portant une habilitation inconnue', () => {
      // Une faute de frappe sur un scope doit fermer la cle, pas lui accorder
      // silencieusement moins de droits que prevu.
      const service = build([`ops|${hashOf(SECRET)}|transfers:reed|Ops`]);
      expect(service.authenticate(`Bearer ops.${SECRET}`)).toBeNull();
    });

    it('ignore un identifiant incompatible avec le format Bearer', () => {
      const service = build([`ops.prod|${hashOf(SECRET)}|${SCOPES.transfersRead}|Ops`]);
      expect(service.authenticate(`Bearer ops.prod.${SECRET}`)).toBeNull();
    });

    it('ferme toutes les entrees lorsque deux cles partagent le meme identifiant', () => {
      const second = randomBytes(16).toString('hex');
      const service = build([ENTRY, `ops|${hashOf(second)}|${SCOPES.transfersWrite}|Deuxieme`]);

      expect(service.authenticate(`Bearer ops.${SECRET}`)).toBeNull();
      expect(service.authenticate(`Bearer ops.${second}`)).toBeNull();
    });

    it('accepte plusieurs cles distinctes', () => {
      const second = randomBytes(16).toString('hex');
      const service = build([
        ENTRY,
        `marchand|${hashOf(second)}|${SCOPES.transfersWrite}|Marchand`,
      ]);

      expect(service.authenticate(`Bearer ops.${SECRET}`)?.keyId).toBe('ops');
      expect(service.authenticate(`Bearer marchand.${second}`)?.scopes).toEqual([
        SCOPES.transfersWrite,
      ]);
    });

    it('retient le libelle par defaut si aucun n est fourni', () => {
      const service = build([`ops|${hashOf(SECRET)}|${SCOPES.transfersRead}`]);
      expect(service.authenticate(`Bearer ops.${SECRET}`)?.label).toBe('ops');
    });

    it('separe les champs par « | » : une habilitation contient deja « : »', () => {
      // Un separateur partage avec le contenu rendrait le decoupage ambigu.
      const service = build([ENTRY]);
      expect(service.authenticate(`Bearer ops.${SECRET}`)?.scopes).toContain('transfers:read');
    });
  });

  describe('desactivation', () => {
    it('signale explicitement que l authentification est coupee', () => {
      expect(build([], false).enabled).toBe(false);
    });
  });
});

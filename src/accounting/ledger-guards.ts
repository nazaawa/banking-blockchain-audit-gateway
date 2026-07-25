/**
 * Garanties du journal, imposees par la base.
 *
 * Elles sont declarees ici en un seul endroit, puis appliquees a la fois par la
 * migration et par l'installateur de demarrage. Le projet a deja paye le prix
 * d'une duplication de ce type entre les deux : deux textes SQL cense etre
 * identiques finissent toujours par diverger.
 */

export const BALANCE_FUNCTION = `
CREATE OR REPLACE FUNCTION "public"."journal_entries_balanced"()
RETURNS trigger AS $$
DECLARE
  debits  numeric(18,2);
  credits numeric(18,2);
BEGIN
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
  INTO debits, credits
  FROM journal_lines
  WHERE entry_id = NEW.id;

  -- Une ecriture sans ligne est une ecriture qui ne dit rien : elle laisserait
  -- croire qu'un fait a ete comptabilise alors que rien n'a bouge.
  IF debits = 0 AND credits = 0 THEN
    RAISE EXCEPTION 'ecriture % sans aucune ligne', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'ecriture % desequilibree : debits=% credits=%', NEW.id, debits, credits
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql`;

/**
 * Le controle est **differe au commit**.
 *
 * Les lignes sont inserees apres l'ecriture qui les porte : verifie
 * immediatement, l'equilibre serait toujours faux au moment de l'insertion de
 * l'en-tete. `DEFERRABLE INITIALLY DEFERRED` laisse la transaction se
 * constituer, puis tranche avant de valider.
 */
export const BALANCE_TRIGGER = `
CREATE CONSTRAINT TRIGGER "trg_journal_entries_balanced"
AFTER INSERT OR UPDATE ON "journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."journal_entries_balanced"()`;

/**
 * Meme controle, declenche depuis les lignes.
 *
 * Sans lui, le declencheur pose sur `journal_entries` ne verrait jamais une
 * ligne ajoutee apres coup a une ecriture existante : l'en-tete n'etant pas
 * touche, rien ne se declencherait. L'equilibre serait alors garanti a la pose
 * initiale seulement — c'est-a-dire pas garanti du tout.
 */
export const LINE_BALANCE_FUNCTION = `
CREATE OR REPLACE FUNCTION "public"."journal_lines_balanced"()
RETURNS trigger AS $$
DECLARE
  target uuid;
  debits  numeric(18,2);
  credits numeric(18,2);
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
  INTO debits, credits
  FROM journal_lines
  WHERE entry_id = target;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'ecriture % desequilibree : debits=% credits=%', target, debits, credits
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql`;

export const LINE_BALANCE_TRIGGER = `
CREATE CONSTRAINT TRIGGER "trg_journal_lines_balanced"
AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."journal_lines_balanced"()`;

export const APPEND_ONLY_FUNCTION = `
CREATE OR REPLACE FUNCTION "public"."journal_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'le journal est append-only : une erreur se corrige par contre-passation (table=%, op=%)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql`;

export const APPEND_ONLY_TRIGGERS = [
  `CREATE TRIGGER "trg_journal_entries_append_only"
   BEFORE UPDATE OR DELETE ON "journal_entries"
   FOR EACH ROW EXECUTE FUNCTION "public"."journal_append_only"()`,
  `CREATE TRIGGER "trg_journal_lines_append_only"
   BEFORE UPDATE OR DELETE ON "journal_lines"
   FOR EACH ROW EXECUTE FUNCTION "public"."journal_append_only"()`,
];

/** Declencheurs poses sur le journal, avec la table qu'ils protegent. */
export const LEDGER_TRIGGERS: ReadonlyArray<[trigger: string, table: string]> = [
  ['trg_journal_entries_balanced', 'journal_entries'],
  ['trg_journal_lines_balanced', 'journal_lines'],
  ['trg_journal_entries_append_only', 'journal_entries'],
  ['trg_journal_lines_append_only', 'journal_lines'],
];

/** Ordre d'installation : fonctions d'abord, declencheurs ensuite. */
export const LEDGER_GUARD_STATEMENTS: readonly string[] = [
  BALANCE_FUNCTION,
  LINE_BALANCE_FUNCTION,
  APPEND_ONLY_FUNCTION,
  BALANCE_TRIGGER,
  LINE_BALANCE_TRIGGER,
  ...APPEND_ONLY_TRIGGERS,
];

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalLine } from './entities/journal-line.entity';
import { LedgerController } from './ledger.controller';
import { LedgerGuardsInstaller } from './ledger-guards.installer';
import { LedgerPostingService } from './ledger-posting.service';

/**
 * Comptabilite en partie double.
 *
 * Le module ne depend **pas** de `EventsModule`, alors que `EventsModule` depend
 * de lui : la comptabilisation est une consequence du fait consigne, jamais
 * l'inverse. Le sens de cette dependance est ce qui garde le registre maitre.
 */
@Module({
  imports: [TypeOrmModule.forFeature([JournalEntry, JournalLine])],
  controllers: [LedgerController],
  providers: [LedgerPostingService, LedgerGuardsInstaller],
  exports: [LedgerPostingService],
})
export class AccountingModule {}

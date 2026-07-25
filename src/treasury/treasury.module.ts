import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

/**
 * Operations de tresorerie.
 *
 * Module distinct de la comptabilite : il **produit** des faits, la comptabilite
 * les **traduit**. Les reunir creerait un cycle entre le registre et le journal,
 * et brouillerait le sens de la dependance.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Transaction]), EventsModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}

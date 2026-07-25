import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { getCorrelationId } from '../context/request-context';
import { maskDeep } from '../utils/masking.util';
import { ErrorResponseDto } from '../dto/error-response.dto';
import {
  SoapCommunicationException,
  SoapFaultException,
  SoapParsingException,
} from '../../soap/exceptions/soap.exceptions';

const PG_UNIQUE_VIOLATION = '23505';

interface NormalizedError {
  statusCode: number;
  error: string;
  message: string | string[];
  reference?: string;
  details?: Record<string, unknown>;
  /** Journalise cote serveur uniquement : jamais renvoye au client. */
  internal?: string;
}

/**
 * Filtre d'exception global.
 *
 * Garantit une enveloppe d'erreur unique et previsible, et empeche toute fuite
 * de detail technique (trace, requete SQL, message de driver) vers le client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const normalized = this.normalize(exception);
    const correlationId = request.correlationId ?? getCorrelationId();

    const body: ErrorResponseDto = {
      statusCode: normalized.statusCode,
      error: normalized.error,
      message: normalized.message,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
      ...(normalized.reference ? { reference: normalized.reference } : {}),
      ...(normalized.details ? { details: normalized.details } : {}),
    };

    const logPayload = {
      event: 'request.exception',
      correlationId,
      method: request.method,
      path: body.path,
      statusCode: body.statusCode,
      error: body.error,
      message: maskDeep(normalized.message),
      ...(normalized.internal ? { internal: normalized.internal } : {}),
    };

    if (normalized.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        ...logPayload,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else {
      this.logger.warn(logPayload);
    }

    response.status(normalized.statusCode).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) return this.fromHttpException(exception);
    if (exception instanceof SoapFaultException) return this.fromSoapFault(exception);
    if (exception instanceof SoapCommunicationException)
      return this.fromSoapCommunication(exception);
    if (exception instanceof SoapParsingException) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'SOAP_INVALID_RESPONSE',
        message: 'La reponse du service externe est inexploitable',
        details: { operation: exception.operation },
        internal: exception.message,
      };
    }
    if (exception instanceof QueryFailedError) return this.fromQueryFailed(exception);

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Une erreur interne est survenue',
      internal: exception instanceof Error ? exception.message : String(exception),
    };
  }

  /**
   * Deplie la reponse d'une `HttpException`.
   *
   * Trois formes sont possibles : chaine simple, payload structure du domaine
   * (`{ error, message, reference, details }`), ou payload du `ValidationPipe`
   * (`{ message: string[] }`).
   */
  private fromHttpException(exception: HttpException): NormalizedError {
    const statusCode = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { statusCode, error: this.codeFromStatus(statusCode), message: payload };
    }

    const record = payload as Record<string, unknown>;
    const message = record.message ?? exception.message;
    const isValidationError = Array.isArray(message);

    return {
      statusCode,
      error:
        typeof record.error === 'string' && !this.looksLikeStatusText(record.error)
          ? record.error
          : isValidationError
            ? 'VALIDATION_ERROR'
            : this.codeFromStatus(statusCode),
      message: (message as string | string[]) ?? 'Erreur',
      reference: typeof record.reference === 'string' ? record.reference : undefined,
      details:
        record.details && typeof record.details === 'object'
          ? (record.details as Record<string, unknown>)
          : undefined,
    };
  }

  private fromSoapFault(exception: SoapFaultException): NormalizedError {
    return {
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'SOAP_FAULT',
      message: `Le service externe a retourne une faute : ${exception.fault.faultString}`,
      details: {
        faultCode: exception.fault.faultCode,
        faultString: exception.fault.faultString,
        soapVersion: exception.fault.soapVersion,
        operation: exception.operation,
      },
    };
  }

  private fromSoapCommunication(exception: SoapCommunicationException): NormalizedError {
    return {
      statusCode: exception.timedOut ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY,
      error: exception.timedOut ? 'SOAP_TIMEOUT' : 'SOAP_UNAVAILABLE',
      message: exception.timedOut
        ? 'Le service externe n a pas repondu dans le delai imparti'
        : 'Le service externe est injoignable',
      details: { operation: exception.operation, attempts: exception.attempts },
      internal: exception.message,
    };
  }

  /** Les erreurs de base ne doivent jamais exposer SQL, colonnes ou contraintes. */
  private fromQueryFailed(exception: QueryFailedError): NormalizedError {
    const driverError = exception.driverError as { code?: string } | undefined;

    if (driverError?.code === PG_UNIQUE_VIOLATION) {
      return {
        statusCode: HttpStatus.CONFLICT,
        error: 'RESOURCE_CONFLICT',
        message: 'La ressource existe deja',
        internal: exception.message,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'DATABASE_ERROR',
      message: 'Une erreur de persistance est survenue',
      internal: exception.message,
    };
  }

  /**
   * `HttpException` place par defaut le libelle du statut dans `error`
   * (« Bad Request », « Not Found »...). On lui prefere un code stable.
   */
  private looksLikeStatusText(value: string): boolean {
    return /\s/.test(value) || /^[A-Z][a-z]/.test(value);
  }

  private codeFromStatus(statusCode: number): string {
    return (
      HttpStatus[statusCode] ?? (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR')
    ).toString();
  }
}

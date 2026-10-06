import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/** Les schémas Zod valident les corps de requête : une entrée invalide est une erreur 400 lisible, pas un 500. */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(error: ZodError, host: ArgumentsHost) {
    const message = error.issues.map((i) => i.message).join(' ; ');
    host.switchToHttp().getResponse<Response>().status(400).json({ statusCode: 400, error: 'Bad Request', message });
  }
}

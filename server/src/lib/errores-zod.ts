import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/**
 * Mensajes de validación en castellano.
 *
 * El sistema está entero en castellano, pero cuando un dato venía mal el
 * detalle lo escribía la librería de validación y salía en inglés: "String
 * must contain at least 1 character(s)". Es lo primero que ve alguien que se
 * equivocó cargando algo, y ahí el sistema deja de parecer suyo.
 *
 * Esto reemplaza los mensajes de fábrica. Los mensajes propios que ya tienen
 * algunos esquemas mandan igual: este mapa solo cubre lo que no tiene uno.
 */

const TIPOS: Record<string, string> = {
  string: 'un texto',
  number: 'un número',
  bigint: 'un número entero',
  boolean: 'sí o no',
  date: 'una fecha',
  array: 'una lista',
  object: 'un objeto',
  integer: 'un número entero',
  float: 'un número',
  null: 'nulo',
  undefined: 'nada',
};

const nombreDeTipo = (tipo: string) => TIPOS[tipo] ?? tipo;

/** "3 caracteres" / "3 elementos" / "3", según lo que se esté midiendo. */
function unidad(tipo: string, cantidad: number | bigint): string {
  const n = Number(cantidad);
  if (tipo === 'string') return `${n} ${n === 1 ? 'caracter' : 'caracteres'}`;
  if (tipo === 'array' || tipo === 'set') return `${n} ${n === 1 ? 'elemento' : 'elementos'}`;
  return String(n);
}

const mapaEnCastellano: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Falta este dato' };
      if (issue.received === 'null') return { message: 'Este dato no puede ir vacío' };
      return { message: `Tiene que ser ${nombreDeTipo(issue.expected)}, no ${nombreDeTipo(issue.received)}` };

    case ZodIssueCode.invalid_literal:
      return { message: `El único valor aceptado acá es ${JSON.stringify(issue.expected)}` };

    case ZodIssueCode.unrecognized_keys:
      return { message: `Sobra${issue.keys.length === 1 ? '' : 'n'}: ${issue.keys.join(', ')}` };

    case ZodIssueCode.invalid_enum_value:
      return {
        message: `"${String(issue.received)}" no es una opción válida. Las que hay: ${issue.options.join(', ')}`,
      };

    case ZodIssueCode.invalid_union:
      return { message: 'El dato no tiene ninguna de las formas esperadas' };

    case ZodIssueCode.invalid_union_discriminator:
      return { message: `Tiene que ser una de estas opciones: ${issue.options.join(', ')}` };

    case ZodIssueCode.invalid_date:
      return { message: 'La fecha no es válida' };

    case ZodIssueCode.invalid_string: {
      if (issue.validation === 'email') return { message: 'No parece un correo' };
      if (issue.validation === 'url') return { message: 'No parece una dirección web' };
      if (issue.validation === 'uuid') return { message: 'No parece un identificador válido' };
      if (typeof issue.validation === 'object' && 'startsWith' in issue.validation) {
        return { message: `Tiene que empezar con "${issue.validation.startsWith}"` };
      }
      if (typeof issue.validation === 'object' && 'endsWith' in issue.validation) {
        return { message: `Tiene que terminar con "${issue.validation.endsWith}"` };
      }
      return { message: 'El formato no es el esperado' };
    }

    case ZodIssueCode.too_small: {
      const cuanto = unidad(issue.type, issue.minimum);
      if (issue.exact) return { message: `Tienen que ser exactamente ${cuanto}` };
      if (issue.type === 'string' && Number(issue.minimum) === 1) {
        return { message: 'No puede quedar vacío' };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: `Tiene que ser ${issue.inclusive ? 'de' : 'mayor que'} ${cuanto} ${issue.inclusive ? 'o más' : ''}`.trim() };
      }
      return { message: `Necesita al menos ${cuanto}` };
    }

    case ZodIssueCode.too_big: {
      const cuanto = unidad(issue.type, issue.maximum);
      if (issue.exact) return { message: `Tienen que ser exactamente ${cuanto}` };
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: `Tiene que ser ${issue.inclusive ? 'de' : 'menor que'} ${cuanto} ${issue.inclusive ? 'o menos' : ''}`.trim() };
      }
      return { message: `Se pasa: como mucho ${cuanto}` };
    }

    case ZodIssueCode.not_multiple_of:
      return { message: `Tiene que ser múltiplo de ${issue.multipleOf}` };

    case ZodIssueCode.not_finite:
      return { message: 'Tiene que ser un número finito' };

    case ZodIssueCode.invalid_intersection_types:
      return { message: 'Los datos no se pueden combinar' };

    default:
      // `custom` y cualquier código nuevo: el mensaje propio del esquema.
      return { message: ctx.defaultError };
  }
};

/** Se llama una sola vez, al armar la aplicación. */
export const usarMensajesEnCastellano = () => z.setErrorMap(mapaEnCastellano);

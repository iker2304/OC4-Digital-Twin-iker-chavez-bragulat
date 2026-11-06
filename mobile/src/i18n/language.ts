/**
 * Idioma de la interfaz: tipo, lista y persistencia.
 *
 * Vive aparte de `index.ts` a propósito: el store necesita leer el idioma al
 * arrancar y `index.ts` importa el store, así que juntarlos crearía un ciclo de
 * imports. Este fichero no depende de React ni del store.
 */

export type Lang = 'es' | 'en' | 'ca' | 'zh';

/** Orden del selector. */
export const LANGUAGES: Array<{ id: Lang; short: string }> = [
    { id: 'es', short: 'ES' },
    { id: 'en', short: 'EN' },
    { id: 'ca', short: 'CA' },
    { id: 'zh', short: '中文' },
];

const STORAGE_KEY = 'oc4.language';

/**
 * Idioma del navegador si lo hablamos, castellano si no.
 * `ca-ES`, `es-MX`, `en-GB`… se resuelven por el prefijo de dos letras.
 */
export function detectLanguage(navigatorLanguage: string | undefined): Lang {
    const prefix = (navigatorLanguage ?? '').slice(0, 2).toLowerCase();
    if (prefix === 'en' || prefix === 'ca' || prefix === 'zh') return prefix;
    return 'es';
}

export function isLang(value: unknown): value is Lang {
    return value === 'es' || value === 'en' || value === 'ca' || value === 'zh';
}

/** Idioma guardado por el usuario; si no hay, el del navegador. */
export function loadLanguage(): Lang {
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (isLang(saved)) return saved;
    } catch {
        // Modo privado o almacenamiento bloqueado: seguimos con el del navegador.
    }
    return detectLanguage(typeof navigator === 'undefined' ? undefined : navigator.language);
}

export function saveLanguage(lang: Lang): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
        // Sin persistencia: el idioma durará lo que la sesión.
    }
}

/**
 * Enhanced Logger Utility
 * Provides environment-aware logging with proper categorization
 */

const isDevelopment = import.meta.env.DEV;

/**
 * Debug logs - only shown in development
 */
export function logDebug(...args: any[]) {
  if (isDevelopment) {
    console.log(...args);
  }
}

/**
 * Info logs - always shown
 */
export function logInfo(...args: any[]) {
  console.log(...args);
}

/**
 * Warning logs - always shown
 */
export function logWarning(...args: any[]) {
  console.warn(...args);
}

/**
 * Error logs - always shown
 */
export function logError(...args: any[]) {
  console.error(...args);
}

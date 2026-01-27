export type Logger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: unknown) => void;
    debug: (message: string) => void;
};

type LoggerOptions = {
    verbose?: boolean;
    silent?: boolean;
};

export function createConsoleLogger(options: LoggerOptions = {}): Logger {
    const { verbose = false, silent = false } = options;
    const noop = () => {};

    if (silent) {
        return { info: noop, warn: noop, error: noop, debug: noop };
    }

    return {
        info: (message) => {
            console.log(message);
        },
        warn: (message) => {
            console.warn(message);
        },
        error: (message, error) => {
            if (error) {
                console.error(message, error);
            } else {
                console.error(message);
            }
        },
        debug: verbose
            ? (message) => {
                  console.log(message);
              }
            : noop
    };
}

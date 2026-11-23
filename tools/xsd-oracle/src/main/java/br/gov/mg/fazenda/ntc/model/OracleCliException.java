package br.gov.mg.fazenda.ntc.model;

/**
 * Exceção controlada para falhas de uso da CLI ou violações de segurança de entrada.
 */
public final class OracleCliException extends RuntimeException {

    private final int exitCode;

    public OracleCliException(int exitCode, String message) {
        super(message);
        this.exitCode = exitCode;
    }

    public OracleCliException(int exitCode, String message, Throwable cause) {
        super(message, cause);
        this.exitCode = exitCode;
    }

    public int getExitCode() {
        return exitCode;
    }
}

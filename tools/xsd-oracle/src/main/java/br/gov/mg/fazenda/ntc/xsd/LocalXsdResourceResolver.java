package br.gov.mg.fazenda.ntc.xsd;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import org.w3c.dom.ls.LSInput;
import org.w3c.dom.ls.LSResourceResolver;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Locale;

/**
 * Resolvedor de recursos XSD restrito ao diretório local informado, bloqueando
 * chamadas de rede (SSRF), DTDs/XXE em inclusões e traversal fora da raiz.
 */
public final class LocalXsdResourceResolver implements LSResourceResolver {

    private static final long MAX_INCLUDED_XSD_BYTES = 20L * 1024L * 1024L;
    private final Path realRootDir;

    public LocalXsdResourceResolver(Path xsdDir) {
        if (xsdDir == null || !Files.isDirectory(xsdDir)) {
            throw new OracleCliException(2, "Diretório XSD inválido: " + xsdDir);
        }
        try {
            this.realRootDir = xsdDir.toRealPath();
        } catch (IOException e) {
            throw new OracleCliException(2, "Diretório XSD inválido: " + xsdDir, e);
        }
    }

    @Override
    public LSInput resolveResource(
            String type,
            String namespaceURI,
            String publicId,
            String systemId,
            String baseURI) {
        if (systemId == null || systemId.trim().isEmpty()) {
            return null;
        }
        String trimmed = systemId.trim();
        rejectUnsafeSchemeOrUnc(trimmed);

        Path resolved = resolveLocalPath(trimmed, baseURI);
        Path safeTarget = verifyInsideRootAndRegular(resolved, trimmed);
        verifyNoDoctype(safeTarget);

        return new PathLsInput(publicId, safeTarget.toUri().toString(), baseURI, safeTarget);
    }

    private void rejectUnsafeSchemeOrUnc(String systemId) {
        if (systemId.startsWith("\\\\") || systemId.startsWith("//")) {
            throw new OracleCliException(2, "Referência UNC/rede XSD bloqueada: " + systemId);
        }
        int colon = systemId.indexOf(':');
        if (colon <= 1) {
            return;
        }
        String scheme = systemId.substring(0, colon).toLowerCase(Locale.ROOT);
        if (!scheme.equals("file")) {
            throw new OracleCliException(2, "Referência XSD externa bloqueada: " + systemId);
        }
    }

    private Path resolveLocalPath(String systemId, String baseURI) {
        try {
            if (systemId.toLowerCase(Locale.ROOT).startsWith("file:")) {
                return parseStrictFileUri(systemId);
            }
            String decoded = decodeRelativeRef(systemId);
            return resolveBaseDir(baseURI).resolve(decoded).normalize();
        } catch (OracleCliException e) {
            throw e;
        } catch (Exception e) {
            throw new OracleCliException(2, "URI XSD inválida em schemaLocation: " + systemId, e);
        }
    }

    private Path parseStrictFileUri(String systemId) {
        URI uri = URI.create(systemId);
        if (uri.isOpaque()
                || hasText(uri.getAuthority())
                || hasText(uri.getHost())
                || uri.getQuery() != null
                || uri.getFragment() != null) {
            throw new OracleCliException(2, "URI file: XSD inválida ou com host remoto: " + systemId);
        }
        return Paths.get(uri).normalize();
    }

    private static boolean hasText(String value) {
        return value != null && !value.isEmpty();
    }

    private String decodeRelativeRef(String ref) throws UnsupportedEncodingException {
        int hash = ref.indexOf('#');
        String withoutFragment = hash >= 0 ? ref.substring(0, hash) : ref;
        return URLDecoder.decode(withoutFragment, "UTF-8");
    }

    private Path resolveBaseDir(String baseURI) {
        if (baseURI != null && baseURI.toLowerCase(Locale.ROOT).startsWith("file:")) {
            try {
                Path parent = Paths.get(URI.create(baseURI)).getParent();
                if (parent != null) {
                    return parent.toAbsolutePath().normalize();
                }
            } catch (Exception ignored) {
                return realRootDir;
            }
        }
        return realRootDir;
    }

    private Path verifyInsideRootAndRegular(Path candidate, String originalRef) {
        Path normalized = candidate.toAbsolutePath().normalize();
        if (!normalized.startsWith(realRootDir)) {
            throw new OracleCliException(2, "Path traversal bloqueado em schemaLocation: " + originalRef);
        }
        if (Files.isSymbolicLink(normalized)) {
            throw new OracleCliException(2, "Symlink bloqueado em schemaLocation: " + originalRef);
        }
        if (Files.exists(normalized, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS)) {
                throw new OracleCliException(2, "Recurso XSD não é arquivo regular: " + originalRef);
            }
            try {
                Path real = normalized.toRealPath();
                if (!real.startsWith(realRootDir)) {
                    throw new OracleCliException(2, "Symlink fora da raiz XSD: " + originalRef);
                }
                if (Files.size(real) > MAX_INCLUDED_XSD_BYTES) {
                    throw new OracleCliException(2, "Arquivo XSD incluído excede limite de tamanho: " + originalRef);
                }
                return real;
            } catch (IOException e) {
                throw new OracleCliException(2, "Erro ao verificar recurso XSD: " + originalRef, e);
            }
        }
        return normalized;
    }

    private void verifyNoDoctype(Path resolved) {
        if (!Files.isRegularFile(resolved, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (InputStream in = Files.newInputStream(resolved)) {
            DocumentBuilderFactory dbf = XsdSecurityConfig.createSecureDocumentBuilderFactory();
            dbf.newDocumentBuilder().parse(in);
        } catch (OracleCliException e) {
            throw e;
        } catch (Exception e) {
            throw new OracleCliException(2, "Recurso XSD incluído inválido ou inseguro: " + resolved, e);
        }
    }

    private static final class PathLsInput implements LSInput {
        private String publicId;
        private String systemId;
        private String baseURI;
        private final Path file;

        private PathLsInput(String publicId, String systemId, String baseURI, Path file) {
            this.publicId = publicId;
            this.systemId = systemId;
            this.baseURI = baseURI;
            this.file = file;
        }

        @Override public Reader getCharacterStream() { return null; }
        @Override public void setCharacterStream(Reader characterStream) { }

        @Override
        public InputStream getByteStream() {
            try {
                return Files.newInputStream(file);
            } catch (IOException e) {
                throw new OracleCliException(2, "Falha ao abrir XSD incluído: " + file, e);
            }
        }

        @Override public void setByteStream(InputStream byteStream) { }
        @Override public String getStringData() { return null; }
        @Override public void setStringData(String stringData) { }
        @Override public String getSystemId() { return systemId; }
        @Override public void setSystemId(String systemId) { this.systemId = systemId; }
        @Override public String getPublicId() { return publicId; }
        @Override public void setPublicId(String publicId) { this.publicId = publicId; }
        @Override public String getBaseURI() { return baseURI; }
        @Override public void setBaseURI(String baseURI) { this.baseURI = baseURI; }
        @Override public String getEncoding() { return "UTF-8"; }
        @Override public void setEncoding(String encoding) { }
        @Override public boolean getCertifiedText() { return false; }
        @Override public void setCertifiedText(boolean certifiedText) { }
    }
}

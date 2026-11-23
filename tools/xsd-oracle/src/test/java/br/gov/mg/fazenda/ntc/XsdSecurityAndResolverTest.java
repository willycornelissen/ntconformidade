package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.xsd.LocalXsdResourceResolver;
import br.gov.mg.fazenda.ntc.xsd.XsdSecurityConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.w3c.dom.ls.LSInput;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class XsdSecurityAndResolverTest {

    @Test
    void resolverValidatesConstructorNullBlankAndRelativeUris(@TempDir Path dir) throws IOException {
        assertEquals(2, assertThrows(OracleCliException.class, () -> new LocalXsdResourceResolver(null)).getExitCode());
        Path nonDir = dir.resolve("missing");
        assertEquals(2, assertThrows(OracleCliException.class, () -> new LocalXsdResourceResolver(nonDir)).getExitCode());

        Path sub = dir.resolve("sub");
        Files.createDirectories(sub);
        Path target = sub.resolve("tipos file.xsd");
        Files.write(
                target,
                "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'/>".getBytes(StandardCharsets.UTF_8));
        Path base = sub.resolve("root.xsd");

        LocalXsdResourceResolver resolver = new LocalXsdResourceResolver(dir);
        assertNull(resolver.resolveResource(null, null, null, null, null));
        assertNull(resolver.resolveResource(null, null, null, "   ", base.toUri().toString()));

        LSInput input = resolver.resolveResource(
                null,
                null,
                "pub1",
                "tipos%20file.xsd#anchor",
                base.toUri().toString());
        assertNotNull(input);
        assertEquals("UTF-8", input.getEncoding());
        assertEquals("pub1", input.getPublicId());
        try (InputStream in = input.getByteStream()) {
            assertTrue(in.read() > 0);
        }
    }

    @Test
    void resolverRejectsTraversalRemoteSchemesQueriesDirectoriesAndBrokenUris(@TempDir Path dir) throws IOException {
        Path sub = dir.resolve("sub");
        Files.createDirectories(sub);
        LocalXsdResourceResolver resolver = new LocalXsdResourceResolver(dir);

        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "../out.xsd", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "\\\\srv\\a.xsd", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "https://example/a.xsd", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "file://remote/a.xsd", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, dir.resolve("a.xsd").toUri() + "?q=1", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, dir.resolve("a.xsd").toUri() + "#frag", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "file:opaque", null));
        assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "sub", null));

        Path outside = Files.createTempFile("outside-res", ".xsd");
        try {
            Path link = dir.resolve("sym.xsd");
            Files.createSymbolicLink(link, outside);
            assertThrows(OracleCliException.class, () -> resolver.resolveResource(null, null, null, "sym.xsd", null));
        } finally {
            Files.deleteIfExists(outside);
        }
    }

    @Test
    void securityConfigRejectsInvalidOrEmptyDirs(@TempDir Path dir) throws IOException {
        assertEquals(2, assertThrows(OracleCliException.class, () -> XsdSecurityConfig.listXsdFiles(null)).getExitCode());
        assertEquals(2, assertThrows(OracleCliException.class, () -> XsdSecurityConfig.listXsdFiles(dir.resolve("missing"))).getExitCode());
        assertEquals(2, assertThrows(OracleCliException.class, () -> XsdSecurityConfig.listXsdFiles(dir)).getExitCode());

        Path regularFile = dir.resolve("not-a-dir.xsd");
        Files.write(regularFile, "<x/>".getBytes(StandardCharsets.UTF_8));
        assertEquals(2, assertThrows(OracleCliException.class, () -> XsdSecurityConfig.listXsdFiles(regularFile)).getExitCode());
    }
}

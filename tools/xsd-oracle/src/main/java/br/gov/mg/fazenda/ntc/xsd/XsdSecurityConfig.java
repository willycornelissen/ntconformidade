package br.gov.mg.fazenda.ntc.xsd;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import org.w3c.dom.ls.LSInput;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.Source;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Fábrica compartilhada de parsers e schemas XML endurecidos contra XXE e SSRF.
 */
public final class XsdSecurityConfig {

    private static final String DISALLOW_DOCTYPE = "http://apache.org/xml/features/disallow-doctype-decl";
    private static final String EXTERNAL_GENERAL = "http://xml.org/sax/features/external-general-entities";
    private static final String EXTERNAL_PARAM = "http://xml.org/sax/features/external-parameter-entities";
    private static final String LOAD_EXTERNAL_DTD = "http://apache.org/xml/features/nonvalidating/load-external-dtd";
    private static final String[] SCHEMA_REF_TAGS = { "include", "import", "redefine", "override" };
    private static final int MAX_XSD_FILES = 500;
    private static final int MAX_WALK_DEPTH = 32;

    private XsdSecurityConfig() {
    }

    public static List<Path> listXsdFiles(Path xsdDir) {
        if (xsdDir == null || !Files.exists(xsdDir) || !Files.isDirectory(xsdDir)) {
            throw new OracleCliException(2, "Diretório XSD inválido ou inexistente: " + xsdDir);
        }
        Path realRoot = normalizeReal(xsdDir);
        try (Stream<Path> walk = Files.walk(realRoot, MAX_WALK_DEPTH)) {
            List<Path> candidates = walk
                    .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".xsd"))
                    .sorted()
                    .collect(Collectors.toList());
            List<Path> files = validateXsdCandidates(candidates, realRoot, xsdDir);
            return files;
        } catch (OracleCliException e) {
            throw e;
        } catch (IOException | UncheckedIOException e) {
            throw new OracleCliException(2, "Falha ao listar arquivos XSD em: " + xsdDir, e);
        }
    }

    private static List<Path> validateXsdCandidates(List<Path> candidates, Path realRoot, Path xsdDir) {
        if (candidates.isEmpty()) {
            throw new OracleCliException(2, "Nenhum arquivo .xsd encontrado em: " + xsdDir);
        }
        if (candidates.size() > MAX_XSD_FILES) {
            throw new OracleCliException(2, "Limite de arquivos .xsd excedido em: " + xsdDir);
        }
        List<Path> validated = new ArrayList<>(candidates.size());
        for (Path candidate : candidates) {
            if (Files.isSymbolicLink(candidate) || !Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)) {
                throw new OracleCliException(2, "Symlink ou arquivo não regular em XSD: " + candidate);
            }
            Path canonical = normalizeReal(candidate);
            if (!canonical.startsWith(realRoot)) {
                throw new OracleCliException(2, "Arquivo XSD fora da raiz permitida: " + candidate);
            }
            validated.add(canonical);
        }
        return validated;
    }

    /**
     * Seleciona raízes XSD suficientes para alcançar todos os arquivos do pacote sem duplicar inclusões.
     */
    public static List<Path> findRootXsds(List<Path> allXsds, Path xsdDir) {
        LocalXsdResourceResolver resolver = new LocalXsdResourceResolver(xsdDir);
        DocumentBuilder builder = createSecureDocumentBuilder();
        Map<Path, Set<Path>> depsByFile = new LinkedHashMap<>();
        Set<Path> includedTargets = new LinkedHashSet<>();

        for (Path xsd : allXsds) {
            Set<Path> refs = collectIncludedPaths(xsd, builder, resolver);
            depsByFile.put(normalizeReal(xsd), refs);
            includedTargets.addAll(refs);
        }

        List<Path> roots = new ArrayList<>();
        Set<Path> covered = new LinkedHashSet<>();
        for (Path xsd : allXsds) {
            Path real = normalizeReal(xsd);
            if (!includedTargets.contains(real)) {
                roots.add(xsd);
                markReachable(real, depsByFile, covered);
            }
        }
        for (Path xsd : allXsds) {
            Path real = normalizeReal(xsd);
            if (!covered.contains(real)) {
                roots.add(xsd);
                markReachable(real, depsByFile, covered);
            }
        }
        return roots;
    }

    public static SAXParserFactory createSecureSaxParserFactory() {
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature(DISALLOW_DOCTYPE, true);
            factory.setFeature(EXTERNAL_GENERAL, false);
            factory.setFeature(EXTERNAL_PARAM, false);
            factory.setFeature(LOAD_EXTERNAL_DTD, false);
            return factory;
        } catch (Exception e) {
            throw new OracleCliException(2, "Falha ao configurar SAXParserFactory seguro", e);
        }
    }

    public static DocumentBuilderFactory createSecureDocumentBuilderFactory() {
        try {
            DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
            dbf.setNamespaceAware(true);
            dbf.setXIncludeAware(false);
            dbf.setExpandEntityReferences(false);
            dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            dbf.setFeature(DISALLOW_DOCTYPE, true);
            dbf.setFeature(EXTERNAL_GENERAL, false);
            dbf.setFeature(EXTERNAL_PARAM, false);
            dbf.setFeature(LOAD_EXTERNAL_DTD, false);
            return dbf;
        } catch (ParserConfigurationException e) {
            throw new OracleCliException(2, "Falha ao criar DocumentBuilderFactory seguro", e);
        }
    }

    public static Schema loadCombinedSchema(Path xsdDir) {
        List<Path> allXsds = listXsdFiles(xsdDir);
        List<Path> rootXsds = findRootXsds(allXsds, xsdDir);
        SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
        try {
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature(DISALLOW_DOCTYPE, true);
            trySetProperty(factory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
            trySetProperty(factory, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "file");
            factory.setResourceResolver(new LocalXsdResourceResolver(xsdDir));

            Source[] sources = new Source[rootXsds.size()];
            for (int i = 0; i < rootXsds.size(); i++) {
                sources[i] = new StreamSource(rootXsds.get(i).toUri().toString());
            }
            return factory.newSchema(sources);
        } catch (OracleCliException e) {
            throw e;
        } catch (Exception e) {
            throw new OracleCliException(2, "Erro ao carregar pacote XSD em: " + xsdDir, e);
        }
    }

    private static DocumentBuilder createSecureDocumentBuilder() {
        try {
            return createSecureDocumentBuilderFactory().newDocumentBuilder();
        } catch (ParserConfigurationException e) {
            throw new OracleCliException(2, "Falha ao criar DocumentBuilder seguro", e);
        }
    }

    private static Set<Path> collectIncludedPaths(
            Path xsd,
            DocumentBuilder builder,
            LocalXsdResourceResolver resolver) {
        Set<Path> includedTargets = new LinkedHashSet<>();
        try (InputStream in = Files.newInputStream(xsd)) {
            Document doc = builder.parse(in);
            for (String tag : SCHEMA_REF_TAGS) {
                scanSchemaRefs(doc, tag, xsd, resolver, includedTargets);
            }
            return includedTargets;
        } catch (OracleCliException e) {
            throw e;
        } catch (Exception e) {
            throw new OracleCliException(2, "XSD inválido ou inseguro: " + xsd + " (" + e.getMessage() + ")", e);
        }
    }

    private static void scanSchemaRefs(
            Document doc,
            String tagName,
            Path sourceXsd,
            LocalXsdResourceResolver resolver,
            Set<Path> includedTargets) {
        NodeList nodes = doc.getElementsByTagNameNS(XMLConstants.W3C_XML_SCHEMA_NS_URI, tagName);
        String baseUri = sourceXsd.toUri().toString();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element el = (Element) nodes.item(i);
            String loc = el.getAttribute("schemaLocation");
            if (loc != null && !loc.trim().isEmpty()) {
                LSInput resolved = resolver.resolveResource(null, null, null, loc, baseUri);
                if (resolved != null && resolved.getSystemId() != null) {
                    Path target = Paths.get(URI.create(resolved.getSystemId()));
                    if (Files.exists(target)) {
                        includedTargets.add(normalizeReal(target));
                    }
                }
            }
        }
    }

    private static void markReachable(Path current, Map<Path, Set<Path>> depsByFile, Set<Path> visited) {
        if (!visited.add(current)) {
            return;
        }
        Set<Path> deps = depsByFile.get(current);
        if (deps != null) {
            for (Path dep : deps) {
                markReachable(dep, depsByFile, visited);
            }
        }
    }

    private static void trySetProperty(SchemaFactory factory, String name, String value) {
        try {
            factory.setProperty(name, value);
        } catch (Exception ignored) {
            // Xerces 2.12 não reconhece propriedades JAXP 1.5; proteção equivalente via SecureDocumentBuilder + resolver
        }
    }

    private static Path normalizeReal(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }
}

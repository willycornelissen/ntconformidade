package br.gov.mg.fazenda.ntc.xsd;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidateXmlResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidationError;
import org.xml.sax.ErrorHandler;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;

import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.sax.SAXSource;
import javax.xml.validation.Schema;
import javax.xml.validation.Validator;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Validador de XMLs sintéticos contra pacotes XSD locais endurecido contra XXE.
 */
public final class XsdXmlValidator {

    static final int MAX_VALIDATION_ERRORS = 500;

    public ValidateXmlResult validate(Path xsdDir, Path xmlFile) {
        validateXmlPath(xmlFile);
        Schema schema = XsdSecurityConfig.loadCombinedSchema(xsdDir);

        List<ValidationError> errors = new ArrayList<>();
        Validator validator = createConfiguredValidator(schema, errors);
        SAXParserFactory saxFactory = XsdSecurityConfig.createSecureSaxParserFactory();

        try (InputStream in = Files.newInputStream(xmlFile)) {
            XMLReader reader = saxFactory.newSAXParser().getXMLReader();
            SAXSource source = new SAXSource(reader, new InputSource(in));
            validator.validate(source);
        } catch (OracleCliException e) {
            throw e;
        } catch (SAXParseException e) {
            addIfMissing(errors, e);
        } catch (SAXException e) {
            if (errors.isEmpty()) {
                errors.add(new ValidationError(1, 1, safeMessage(e)));
            }
        } catch (IOException e) {
            throw new OracleCliException(2, "Falha de leitura do XML: " + xmlFile, e);
        } catch (Exception e) {
            throw new OracleCliException(2, "Erro interno ao validar XML: " + safeMessage(e), e);
        }

        return new ValidateXmlResult(errors.isEmpty(), errors);
    }

    private void validateXmlPath(Path xmlFile) {
        if (xmlFile == null
                || Files.isSymbolicLink(xmlFile)
                || !Files.exists(xmlFile, LinkOption.NOFOLLOW_LINKS)
                || !Files.isRegularFile(xmlFile, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(xmlFile)) {
            throw new OracleCliException(2, "Arquivo XML inválido ou ilegível: " + xmlFile);
        }
    }

    private Validator createConfiguredValidator(Schema schema, List<ValidationError> errors) {
        Validator validator = schema.newValidator();
        validator.setResourceResolver((type, ns, pub, sys, base) -> {
            throw new OracleCliException(2, "Resolução externa bloqueada na validação XML: " + sys);
        });
        trySetProperty(validator, XMLConstants.ACCESS_EXTERNAL_DTD, "");
        trySetProperty(validator, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        validator.setErrorHandler(new CollectingErrorHandler(errors));
        return validator;
    }

    private static void trySetProperty(Validator validator, String prop, String value) {
        try {
            validator.setProperty(prop, value);
        } catch (Exception ignored) {
            // SAXSource já bloqueia DOCTYPE e entidades externas
        }
    }

    private void addIfMissing(List<ValidationError> errors, SAXParseException e) {
        if (errors.size() >= MAX_VALIDATION_ERRORS) {
            return;
        }
        String msg = safeMessage(e);
        int line = Math.max(1, e.getLineNumber());
        int col = Math.max(1, e.getColumnNumber());
        for (ValidationError existing : errors) {
            if (existing.getLine() == line && existing.getMessage().equals(msg)) {
                return;
            }
        }
        errors.add(new ValidationError(line, col, msg));
    }

    private static String safeMessage(Throwable t) {
        return t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
    }

    private static final class CollectingErrorHandler implements ErrorHandler {
        private final List<ValidationError> errors;

        private CollectingErrorHandler(List<ValidationError> errors) {
            this.errors = errors;
        }

        @Override
        public void warning(SAXParseException e) {
            // Avisos não invalidam o documento XML contra o XSD
        }

        @Override
        public void error(SAXParseException e) {
            record(e);
        }

        @Override
        public void fatalError(SAXParseException e) {
            record(e);
        }

        private void record(SAXParseException e) {
            if (errors.size() >= MAX_VALIDATION_ERRORS) {
                return;
            }
            errors.add(new ValidationError(
                    Math.max(1, e.getLineNumber()),
                    Math.max(1, e.getColumnNumber()),
                    safeMessage(e)));
        }
    }
}

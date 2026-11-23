package br.gov.mg.fazenda.ntc.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Contratos imutáveis de entrada e saída JSON do utilitário {@code xsd-oracle}.
 */
public final class OracleDtos {

    private OracleDtos() {
    }

    public static final class XsdNode {
        private final String tagPath;
        private final String xsdType;
        private final int minOccurs;
        private final Object maxOccurs;
        private final boolean attribute;

        @JsonCreator
        public XsdNode(
                @JsonProperty("tagPath") String tagPath,
                @JsonProperty("xsdType") String xsdType,
                @JsonProperty("minOccurs") int minOccurs,
                @JsonProperty("maxOccurs") Object maxOccurs,
                @JsonProperty("isAttribute") boolean attribute) {
            this.tagPath = tagPath;
            this.xsdType = xsdType;
            this.minOccurs = minOccurs;
            this.maxOccurs = maxOccurs;
            this.attribute = attribute;
        }

        public String getTagPath() {
            return tagPath;
        }

        public String getXsdType() {
            return xsdType;
        }

        public int getMinOccurs() {
            return minOccurs;
        }

        public Object getMaxOccurs() {
            return maxOccurs;
        }

        @JsonProperty("isAttribute")
        public boolean isAttribute() {
            return attribute;
        }
    }

    public static final class ExtractXsdResult {
        private final List<String> rootElements;
        private final List<XsdNode> nodes;

        @JsonCreator
        public ExtractXsdResult(
                @JsonProperty("rootElements") List<String> rootElements,
                @JsonProperty("nodes") List<XsdNode> nodes) {
            this.rootElements = safeImmutableList(rootElements);
            this.nodes = safeImmutableList(nodes);
        }

        public List<String> getRootElements() {
            return rootElements;
        }

        public List<XsdNode> getNodes() {
            return nodes;
        }
    }

    public static final class ValidationError {
        private final int line;
        private final int column;
        private final String message;

        @JsonCreator
        public ValidationError(
                @JsonProperty("line") int line,
                @JsonProperty("column") int column,
                @JsonProperty("message") String message) {
            this.line = line;
            this.column = column;
            this.message = message;
        }

        public int getLine() {
            return line;
        }

        public int getColumn() {
            return column;
        }

        public String getMessage() {
            return message;
        }
    }

    public static final class ValidateXmlResult {
        private final boolean valid;
        private final List<ValidationError> errors;

        @JsonCreator
        public ValidateXmlResult(
                @JsonProperty("valid") boolean valid,
                @JsonProperty("errors") List<ValidationError> errors) {
            this.valid = valid;
            this.errors = safeImmutableList(errors);
        }

        public boolean isValid() {
            return valid;
        }

        public List<ValidationError> getErrors() {
            return errors;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static final class RegistryEntry {
        private String dfe;
        private String basePackage;
        private String domainPackage;
        private String mapperPackage;
        private String tablePackage;
        private String parserPackage;
        private String utilPackage;
        private String tagPrefix;

        public String getDfe() {
            return dfe;
        }

        public void setDfe(String dfe) {
            this.dfe = dfe;
        }

        public String getBasePackage() {
            return basePackage;
        }

        public void setBasePackage(String basePackage) {
            this.basePackage = basePackage;
        }

        public String getDomainPackage() {
            return domainPackage;
        }

        public void setDomainPackage(String domainPackage) {
            this.domainPackage = domainPackage;
        }

        public String getMapperPackage() {
            return mapperPackage;
        }

        public void setMapperPackage(String mapperPackage) {
            this.mapperPackage = mapperPackage;
        }

        public String getTablePackage() {
            return tablePackage;
        }

        public void setTablePackage(String tablePackage) {
            this.tablePackage = tablePackage;
        }

        public String getParserPackage() {
            return parserPackage;
        }

        public void setParserPackage(String parserPackage) {
            this.parserPackage = parserPackage;
        }

        public String getUtilPackage() {
            return utilPackage;
        }

        public void setUtilPackage(String utilPackage) {
            this.utilPackage = utilPackage;
        }

        public String getTagPrefix() {
            return tagPrefix;
        }

        public void setTagPrefix(String tagPrefix) {
            this.tagPrefix = tagPrefix;
        }
    }

    public static final class SetterKeyEntry {
        private final String fullTagPath;
        private final String leafTag;
        private final String mapperClass;
        private final String targetDtoField;

        @JsonCreator
        public SetterKeyEntry(
                @JsonProperty("fullTagPath") String fullTagPath,
                @JsonProperty("leafTag") String leafTag,
                @JsonProperty("mapperClass") String mapperClass,
                @JsonProperty("targetDtoField") String targetDtoField) {
            this.fullTagPath = fullTagPath;
            this.leafTag = leafTag;
            this.mapperClass = mapperClass;
            this.targetDtoField = targetDtoField;
        }

        public String getFullTagPath() {
            return fullTagPath;
        }

        public String getLeafTag() {
            return leafTag;
        }

        public String getMapperClass() {
            return mapperClass;
        }

        public String getTargetDtoField() {
            return targetDtoField;
        }
    }

    public static final class JsonPropertyEntry {
        private final String className;
        private final String fieldName;
        private final String jsonName;

        @JsonCreator
        public JsonPropertyEntry(
                @JsonProperty("className") String className,
                @JsonProperty("fieldName") String fieldName,
                @JsonProperty("jsonName") String jsonName) {
            this.className = className;
            this.fieldName = fieldName;
            this.jsonName = jsonName;
        }

        public String getClassName() {
            return className;
        }

        public String getFieldName() {
            return fieldName;
        }

        public String getJsonName() {
            return jsonName;
        }
    }

    public static final class TableFieldEntry {
        private final String tableClass;
        private final String fieldName;

        @JsonCreator
        public TableFieldEntry(
                @JsonProperty("tableClass") String tableClass,
                @JsonProperty("fieldName") String fieldName) {
            this.tableClass = tableClass;
            this.fieldName = fieldName;
        }

        public String getTableClass() {
            return tableClass;
        }

        public String getFieldName() {
            return fieldName;
        }
    }

    public static final class ExtractJavaAstResult {
        private final List<SetterKeyEntry> setterKeys;
        private final List<JsonPropertyEntry> jsonProperties;
        private final List<TableFieldEntry> tableFields;

        @JsonCreator
        public ExtractJavaAstResult(
                @JsonProperty("setterKeys") List<SetterKeyEntry> setterKeys,
                @JsonProperty("jsonProperties") List<JsonPropertyEntry> jsonProperties,
                @JsonProperty("tableFields") List<TableFieldEntry> tableFields) {
            this.setterKeys = safeImmutableList(setterKeys);
            this.jsonProperties = safeImmutableList(jsonProperties);
            this.tableFields = safeImmutableList(tableFields);
        }

        public List<SetterKeyEntry> getSetterKeys() {
            return setterKeys;
        }

        public List<JsonPropertyEntry> getJsonProperties() {
            return jsonProperties;
        }

        public List<TableFieldEntry> getTableFields() {
            return tableFields;
        }
    }

    private static <T> List<T> safeImmutableList(List<T> input) {
        return input == null
                ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(input));
    }
}

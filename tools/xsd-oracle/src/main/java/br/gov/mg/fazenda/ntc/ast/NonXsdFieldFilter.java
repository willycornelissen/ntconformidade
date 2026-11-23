package br.gov.mg.fazenda.ntc.ast;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Filtro determinístico de campos internos de ingestão/controle que não
 * correspondem a tags do esquema XSD oficial.
 */
public final class NonXsdFieldFilter {

    private static final Set<String> EXCLUDED_FIELDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "idcarga",
            "endipTransmissor".toLowerCase(Locale.ROOT),
            "nrportaorigem",
            "keyobjectstorage"
    )));

    private NonXsdFieldFilter() {
    }

    public static boolean isExcludedField(String fieldName, String ownerClass) {
        if (fieldName == null || fieldName.trim().isEmpty()) {
            return true;
        }
        String lower = fieldName.trim().toLowerCase(Locale.ROOT);
        if (EXCLUDED_FIELDS.contains(lower)) {
            return true;
        }
        if (lower.equals("id_cnpj") || (lower.startsWith("id_") && lower.endsWith("_cnpj"))) {
            return true;
        }
        return ownerClass != null
                && ownerClass.endsWith("MetadataTable")
                && lower.startsWith("qtd");
    }
}

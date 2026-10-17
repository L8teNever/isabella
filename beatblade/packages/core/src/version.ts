// Algorithmus-Versionen. Erhoehen, wenn sich das Ergebnis aendert –
// der Server markiert dann alte Analysen/Levels als veraltet und erzeugt sie neu.
export const ANALYSIS_VERSION = 4;
export const MAPPING_VERSION = 5;
/** Version des Orbit-Generators: erhoehen, wenn sich Orbit-Levels aendern (Schnitt-Levels bleiben dann unberuehrt) */
export const ORBIT_MAPPING_VERSION = 3;
/** Version des Duett-Generators (Stimme 1/2): erhoehen, wenn sich Duett-Levels aendern (Solo bleibt unberuehrt) */
export const DUET_MAPPING_VERSION = 1;

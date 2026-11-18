# Riftbound Deck Advisor · prototipo local

Prototipo en español para comparar listas por leyenda y encontrar alternativas a las cartas que faltan usando una colección personal. La app funciona en el navegador, no necesita Node ni paquetes, y guarda los datos en IndexedDB local.

## Abrir

Desde esta carpeta, inicia el servidor estático de Python:

```bash
python3 -m http.server 8000
```

Abre `http://localhost:8000`. No se envían a un servidor los catálogos importados, las listas ni la colección. La interfaz tampoco carga librerías externas.

## Archivos de entrada

Importa los tres archivos desde **Cargar mis datos**. Puedes actualizar cada uno por separado.

### 1. Catálogo (`JSON`)

Un array de cartas o un objeto con una propiedad `cards`. Se aceptan nombres de campos habituales como `printing_id`, `oracle_id`, `cardId`, `text`, `energy` y `power`.

```json
{
  "cards": [
    {
      "id": "ogn-001",
      "oracle_id": "card-001",
      "name": "Nombre de carta",
      "type": "Unit",
      "domains": ["Fury"],
      "energy": 2,
      "power": 1,
      "might": 3,
      "keywords": [],
      "tags": [],
      "rules_text": "Texto de efecto"
    }
  ]
}
```

### 2. Listas (`JSON`)

Un array de listas o un objeto con `decks`/`lists`. Incluye `legend` y `cards`; cada entrada de carta lleva `card_id` o `name` y `quantity`. Los campos `event`, `date`, `placement`, `source` y `url` son opcionales y ayudan a contextualizar la muestra.

```json
{
  "decks": [
    {
      "id": "lista-1",
      "name": "Lista de ejemplo",
      "legend": "Nombre de leyenda",
      "champion": "Nombre de campeón",
      "event": "Torneo",
      "date": "2026-10-01",
      "placement": 1,
      "cards": [{ "card_id": "ogn-001", "quantity": 3 }]
    }
  ]
}
```

Cada lista debe contener las cartas del mazo principal. Las runas, leyenda, campeón y campos de batalla pueden quedar fuera en esta fase.

### 3. Colección (`CSV`)

Cabeceras mínimas: `card_id,quantity`. También se admite `name,quantity`. El identificador debe corresponder al catálogo importado; las distintas impresiones se agrupan por `oracle_id` cuando está disponible.

```csv
card_id,quantity
ogn-001,2
ogn-014,3
```

## Qué hace la primera versión

- Resume la frecuencia de inclusión y las copias medias por leyenda a partir de las listas importadas.
- Compara una lista base con la colección y marca las copias que faltan.
- Propone hasta tres cartas disponibles del mismo tipo y explica coincidencias detectadas de función, coste, dominio y etiquetas.
- Permite descargar una copia de seguridad JSON y restaurarla importándola como catálogo.

La puntuación es heurística. El prototipo no confirma que una sustitución sea estratégicamente equivalente, no valida límites de copias ni legalidad del formato y no descarga imágenes. La frecuencia refleja únicamente la muestra cargada, junto con su fecha y tamaño.

## Fuentes y publicación

Para uso local, importa exportaciones de fuentes a las que tengas acceso y conserva la procedencia en `source`/`url`. No se han conectado APIs ni se hace scraping. Antes de distribuir la app, conviene solicitar la clave de Riot específica para la aplicación y confirmar permisos de cada fuente de listas: Riot indica que las apps de Riftbound deben usar una clave API aprobada o una licencia escrita, y da como ejemplos aprobados los deckbuilders y las bibliotecas de cartas ([política oficial de Riot](https://developer.riotgames.com/docs/riftbound)).

Si se comparte públicamente, debe mostrarse este aviso de Riot:

> Riftbound Deck Advisor was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.


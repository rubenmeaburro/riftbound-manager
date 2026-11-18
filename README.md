# Riftbound Deck Advisor · prototipo local

Prototipo en español para buscar listas por leyenda, compararlas con una colección personal y encontrar alternativas a las cartas que faltan. La app funciona en el navegador, no necesita Node ni paquetes. El catálogo, la colección y las listas importadas manualmente se guardan en IndexedDB local; las listas consultadas en TopDeck se conservan solo en memoria durante la sesión.

## Abrir

Desde esta carpeta, inicia el servidor local de Python:

```bash
python3 server.py
```

Abre `http://localhost:8000`. Al iniciar, puedes pegar en la Terminal la clave gratuita de TopDeck.gg; no se verá mientras la escribes. Pulsa Enter sin escribir nada si todavía no tienes clave. Para detener el servidor, pulsa `Ctrl+C` en esa Terminal. No se envían a servicios externos tus catálogos importados, las listas guardadas ni tu colección. La interfaz tampoco carga librerías externas.

## Archivos de entrada

Importa tu colección desde **Cargar mis datos**. El catálogo también se puede actualizar con un clic desde la API pública de RiftHunt. Para buscar mazos, escribe una leyenda como “Riven” en el panel principal: la app consulta las listas públicas automáticamente y selecciona primero la que más cartas puedas completar con tu colección.

### 1. Catálogo (`JSON`)

Un array de cartas o un objeto con una propiedad `cards`. Se aceptan nombres de campos habituales como `printing_id`, `oracle_id`, `cardId`, `text`, `energy` y `power`. También puedes pulsar **Actualizar catálogo** en el importador para descargar el catálogo completo desde RiftHunt.

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

Puedes importar directamente el CSV exportado por Piltover Archive. Se reconocen sus columnas `Variant Number`, `Card Name` y `Quantity`, además del formato mínimo `card_id,quantity` y `name,quantity`. Se detectan comas, punto y coma o tabuladores; las distintas impresiones se agrupan por `oracle_id` cuando está disponible.

```csv
card_id,quantity
ogn-001,2
ogn-014,3
```

## Fuentes públicas

- **Cartas:** RiftHunt publica un endpoint JSON documentado y con CORS abierto. El botón consulta `https://api.rifthunt.com/bulk/cards`, guarda el resultado en el navegador y limita las descargas a una por cada 24 horas. Es un espejo comunitario de datos de cartas; no descarga imágenes. [Documentación de la API](https://rifthunt.com/api/).
- **Alternativa futura para cartas:** OpenRift también ofrece un catálogo JSON sin clave, además de precios y reglas. No está conectado en este prototipo; puede añadirse como fuente alternativa si hace falta comparar cobertura o campos. [Documentación de OpenRift](https://openrift.app/developers).
- **Colección:** importa el CSV exportado por Piltover Archive. Sus rutas de API de lectura no tienen documentación oficial pública, así que el prototipo no depende de endpoints internos o reversados de esa web.
- **Listas de torneos:** la búsqueda automática consulta TopDeck.gg por leyenda, formato, periodo y tamaño mínimo del torneo. La API ofrece listas públicas, pero aparecen solo si el organizador terminó el evento o habilitó su visibilidad; se requiere una clave gratuita y un enlace de atribución. El pequeño servidor local guarda la clave solo en memoria durante esa sesión. Las listas consultadas quedan en memoria mientras esté abierta la página y no se guardan ni se incluyen en las copias de seguridad. [Documentación y clave de TopDeck.gg](https://topdeck.gg/docs/tournaments-v2) · [condiciones de desarrollador](https://topdeck.gg/developer-terms).

Hay otras webs comunitarias que publican listas, pero no he encontrado documentación pública de API para conectarlas de forma estable. Se pueden añadir más adelante como fuentes si ofrecen exportación o una API autorizada; por ahora se evita depender de scraping que se rompa con cambios de página.

La app solicita RiftHunt solo cuando pulsas **Actualizar catálogo** y TopDeck.gg cuando buscas una leyenda. Tu colección CSV y las listas importadas manualmente permanecen en IndexedDB local y no se envían a esas fuentes. Como TopDeck limita la frecuencia de consulta, el servidor espera antes de aceptar una nueva petición.

## Qué hace la primera versión

- Resume la frecuencia de inclusión y las copias medias por leyenda a partir de las listas importadas.
- Compara una lista base con la colección y marca las copias que faltan.
- Propone hasta tres cartas disponibles del mismo tipo y explica coincidencias detectadas de función, coste, dominio y etiquetas.
- Permite descargar una copia de seguridad JSON y restaurarla importándola como catálogo.

La puntuación es heurística. El prototipo no confirma que una sustitución sea estratégicamente equivalente, no valida límites de copias ni legalidad del formato y no descarga imágenes. La frecuencia refleja únicamente la muestra cargada, junto con su fecha y tamaño.

## Fuentes y publicación

Conserva la procedencia en `source`/`url` al importar listas manualmente. No se hace scraping. Riot anima herramientas como deckbuilders y bibliotecas de cartas, pero requiere una clave API específica para la app o una licencia escrita. Su política también prohíbe publicar o retener datos que definan el metajuego, como tasas de uso de cartas o mazos. Por eso esta versión conserva las listas de TopDeck solo en memoria durante la sesión; antes de distribuir el producto, habrá que solicitar aprobación y confirmar el alcance de la función de popularidad ([política oficial de Riot](https://developer.riotgames.com/docs/riftbound)).

Si se comparte públicamente, debe mostrarse este aviso de Riot:

> Riftbound Deck Advisor was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.


"""Local app server plus a small, key-safe TopDeck.gg proxy."""

from __future__ import annotations

import getpass
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
TOPDECK_URL = "https://topdeck.gg/api/v2/tournaments"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
TOPDECK_API_KEY = os.environ.get("TOPDECK_API_KEY", "").strip()
LAST_TOPDECK_REQUEST = 0.0


def normalized(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(character for character in text if not unicodedata.combining(character)).lower().strip()


def pick_count(value: object) -> int:
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, dict):
        for key in ("quantity", "count", "copies", "qty", "amount", "number"):
            if key in value:
                try:
                    return max(0, int(value[key]))
                except (TypeError, ValueError):
                    return 1
    return 1


def rows_from_card_data(data: object) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                name = next((item.get(key) for key in ("name", "card", "cardName", "card_name") if item.get(key)), "")
                quantity = pick_count(item)
                if name and quantity:
                    rows.append({"card_id": str(name), "quantity": quantity})
        return rows
    if not isinstance(data, dict):
        return rows

    for container_key in ("cards", "mainboard", "mainDeck", "main_deck", "main"):
        nested = data.get(container_key)
        if isinstance(nested, (dict, list)):
            rows.extend(rows_from_card_data(nested))
            if rows:
                return rows

    metadata = {"name", "id", "quantity", "count", "copies", "qty", "amount", "number", "type", "section"}
    if any(key in data for key in ("name", "card", "cardName", "card_name")):
        name = next((data.get(key) for key in ("name", "card", "cardName", "card_name") if data.get(key)), "")
        quantity = pick_count(data)
        if name and quantity:
            rows.append({"card_id": str(name), "quantity": quantity})
        return rows

    for name, value in data.items():
        if normalized(name) in metadata:
            continue
        if isinstance(value, (dict, int, float)) or value is None:
            quantity = pick_count(value)
            if quantity:
                rows.append({"card_id": str(name), "quantity": quantity})
        elif isinstance(value, list):
            rows.extend(rows_from_card_data(value))
    return rows


def cards_from_deck_object(deck_object: object) -> list[dict[str, object]]:
    if isinstance(deck_object, list):
        return rows_from_card_data(deck_object)
    if not isinstance(deck_object, dict):
        return []

    exact_main = {"main", "mainboard", "maindeck", "main deck", "main deck cards", "main deck list"}
    for section, contents in deck_object.items():
        if normalized(section).replace("_", " ") in exact_main:
            return rows_from_card_data(contents)

    excluded = ("legend", "champion", "rune", "battlefield", "sideboard", "leader", "commander", "token")
    rows: list[dict[str, object]] = []
    for section, contents in deck_object.items():
        key = normalized(section)
        if any(word in key for word in excluded):
            continue
        rows.extend(rows_from_card_data(contents))
    return rows


def cards_from_deck_text(text: object) -> list[dict[str, object]]:
    if not isinstance(text, str):
        return []
    rows: dict[str, int] = {}
    in_main = True
    for raw_line in text.splitlines():
        line = raw_line.strip().strip("*#- ")
        if not line:
            continue
        header = normalized(line.strip("~[]: "))
        if any(word in header for word in ("rune", "battlefield", "sideboard", "legend", "champion", "leader", "commander")):
            in_main = False
            continue
        if any(word in header for word in ("main deck", "mainboard", "main deck list", "deck")):
            in_main = True
            continue
        if not in_main:
            continue
        match = re.match(r"^\s*(\d+)\s*[x×]?\s+(.+?)\s*$", line)
        if not match:
            match = re.match(r"^\s*(.+?)\s+[x×]\s*(\d+)\s*$", line)
            if match:
                name, count = match.group(1), match.group(2)
            else:
                continue
        else:
            count, name = match.group(1), match.group(2)
        name = name.strip(" -\t")
        if name:
            rows[name] = rows.get(name, 0) + max(1, int(count))
    return [{"card_id": name, "quantity": quantity} for name, quantity in rows.items()]


def event_timestamp(value: object) -> str:
    try:
        stamp = float(value)
        if stamp > 10_000_000_000:
            stamp /= 1000
        return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return ""


def event_list(payload: object) -> list[dict[str, object]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("tournaments", "events", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def normalize_topdeck(payload: object, legend_query: str = "") -> list[dict[str, object]]:
    decks: list[dict[str, object]] = []
    seen: set[str] = set()
    wanted_legend = normalized(legend_query)
    for event in event_list(payload):
        event_id = str(event.get("TID") or event.get("tid") or event.get("id") or "event")
        event_name = str(event.get("tournamentName") or event.get("name") or event_id)
        event_date = event_timestamp(event.get("startDate") or event.get("date"))
        standings = event.get("standings") or []
        if not isinstance(standings, list):
            continue
        for index, player in enumerate(standings):
            if not isinstance(player, dict):
                continue
            leader = str(player.get("leader") or "")
            if wanted_legend and wanted_legend not in normalized(leader):
                continue
            cards = cards_from_deck_object(player.get("deckObj"))
            if not cards:
                cards = cards_from_deck_text(player.get("decklist"))
            if not cards:
                continue
            player_id = str(player.get("id") or player.get("name") or index)
            deck_id = f"topdeck:{event_id}:{player_id}"
            if deck_id in seen:
                continue
            seen.add(deck_id)
            player_name = str(player.get("name") or f"Lista {index + 1}")
            decks.append({
                "id": deck_id,
                "name": f"{player_name} · {event_name}",
                "legend": leader or "Sin leyenda",
                "champion": "",
                "event": event_name,
                "date": event_date,
                "placement": player.get("standing"),
                "source": "TopDeck.gg",
                "url": f"https://topdeck.gg/event/{event_id}",
                "cards": cards,
            })
    return decks


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        global LAST_TOPDECK_REQUEST
        if self.path != "/api/topdeck/decks":
            self.send_json(404, {"error": "Ruta no encontrada."})
            return
        if not TOPDECK_API_KEY:
            self.send_json(503, {"error": "Falta la clave gratuita de TopDeck. Crea una desde su Developer Portal y configura el servidor local al arrancarlo; la clave no debe pegarse en la app ni en el repositorio."})
            return
        if time.monotonic() - LAST_TOPDECK_REQUEST < 12:
            self.send_json(429, {"error": "Espera unos segundos antes de volver a consultar TopDeck."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 4096:
                self.send_json(400, {"error": "Solicitud vacía o demasiado grande."})
                return
            options = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(options, dict):
                self.send_json(400, {"error": "Los filtros enviados no son válidos."})
                return
            legend_query = str(options.get("legend", "")).strip()
            if not legend_query or len(legend_query) > 80:
                self.send_json(400, {"error": "Escribe una leyenda de hasta 80 caracteres."})
                return
            days = max(7, min(365, int(options.get("days", 90))))
            minimum = max(0, min(1024, int(options.get("minimumPlayers", 8))))
            game_format = str(options.get("format", "Constructed"))
            if game_format not in {"Constructed", "Limited", "Sealed", "2v2", "Free-for-All"}:
                self.send_json(400, {"error": "Formato de Riftbound no reconocido."})
                return
            request_body = {
                "game": "Riftbound",
                "format": game_format,
                "last": days,
                "participantMin": minimum,
                "columns": ["name", "id", "decklist", "wins", "draws", "losses", "winRate", "metrics"],
                "rounds": False,
            }
            request = Request(
                TOPDECK_URL,
                data=json.dumps(request_body).encode("utf-8"),
                headers={
                    "Authorization": TOPDECK_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "RiftboundDeckAdvisor/0.1 (local prototype)",
                },
                method="POST",
            )
            LAST_TOPDECK_REQUEST = time.monotonic()
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            decks = normalize_topdeck(payload, legend_query)
            self.send_json(200, {"source": "TopDeck.gg", "fetched": datetime.now(timezone.utc).isoformat(), "decks": decks, "count": len(decks)})
        except HTTPError as error:
            if error.code == 429:
                self.send_json(429, {"error": "TopDeck alcanzó su límite de consultas. Espera un minuto y vuelve a intentar."})
            elif error.code in (401, 403):
                self.send_json(error.code, {"error": "TopDeck rechazó la clave. Comprueba que sea una clave de API válida."})
            else:
                self.send_json(502, {"error": f"TopDeck respondió con el estado {error.code}."})
        except (URLError, TimeoutError):
            self.send_json(502, {"error": "No se pudo conectar con TopDeck. Comprueba la conexión e inténtalo más tarde."})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(502, {"error": "La respuesta de TopDeck no tenía un formato JSON válido."})
        except (TypeError, ValueError):
            self.send_json(400, {"error": "Los filtros enviados no son válidos."})
        except Exception:
            self.send_json(500, {"error": "No se pudo procesar la consulta de TopDeck."})


def main() -> None:
    global TOPDECK_API_KEY
    if not TOPDECK_API_KEY and sys.stdin.isatty():
        print("El catálogo de cartas y la importación CSV funcionan sin clave.")
        print("La clave gratuita de TopDeck es opcional y se guarda solo en memoria durante esta sesión.")
        try:
            TOPDECK_API_KEY = getpass.getpass("Clave de TopDeck (Enter para omitir): ").strip()
        except (EOFError, KeyboardInterrupt):
            TOPDECK_API_KEY = ""
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Prototipo en http://{HOST}:{PORT}")
    print("Pulsa Ctrl+C para cerrar el servidor.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

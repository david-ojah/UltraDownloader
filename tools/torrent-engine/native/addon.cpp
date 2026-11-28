// tools/torrent-engine/native/addon.cpp
//
// In-process N-API addon around libtorrent 2.0.x. The Electron main process
// loads torrent_addon.node directly; there is no child process, socket, token
// or HTTP layer. src/torrent-engine/engine.js calls:
//
//   addon.call(method, params) -> Promise<{ok, result, error}>
//
// API (method, params):
//   startTorrent {torrent: "<magnet or .torrent path>", saveDir: "<dir>"}
//       -> {infoHash, name, isMagnet}
//   status {infoHash} -> {progress, downKbps, upKbps,
//                         uploadPayloadKbps, downloadPayloadKbps,
//                         peers, seeds, pieces, piecesTotal, state, error,
//                         totalDone, totalWanted, totalWantedDone, uploaded,
//                         allTimeUpload, allTimeDownload, etaSeconds,
//                         currentTracker, nextAnnounceSec, numComplete,
//                         numIncomplete, listPeers, distributedCopies,
//                         numConnections, numUploads, activeSeconds,
//                         seedingSeconds, uploadLimitKbps, downloadLimitKbps,
//                         files, alerts}
//   setInterfaces {addresses: ["1.2.3.4", ...], guids?: [...], port?: 6881}
//       -> {method, listenInterfaces, outgoingInterfaces, ports, alerts}
//   setFilePriorities {infoHash, priorities: [4, 0, ...]}
//   setLimits {infoHash?, uploadKbps, downloadKbps}
//   setSessionLimits {uploadKbps, downloadKbps}
//   peerList {infoHash} -> {infoHash, peers: [{ip, port, ...}]}
//   updateTrackers {infoHash} -> {reannounced, scraped, infoHash}
//       Force a tracker re-announce and scrape now. libtorrent still honours
//       each tracker's min_interval, so repeated clicks may be rate-limited.
//   pauseTorrent {infoHash} / resumeTorrent {infoHash}
//   removeTorrent {infoHash, deleteFiles?: true}
//   stop -> {stopped: true} (drops the session; the next call starts clean)
//   ping -> {pong: true, version: "..."}
//
// Build: see native/build.ps1 and README.md.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <libtorrent/session.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/peer_info.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/version.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Minimal JSON value / parser / writer (objects keep insertion order via map,
// which is adequate for this spike's small documents).
// ---------------------------------------------------------------------------

struct Json {
  enum Type { NUL, BOOL, NUM, STR, ARR, OBJ } type = NUL;
  bool boolean = false;
  double number = 0.0;
  std::string string;
  std::vector<Json> array;
  std::map<std::string, Json> object;

  static Json obj() { Json j; j.type = OBJ; return j; }
  static Json arr() { Json j; j.type = ARR; return j; }
  static Json str(const std::string& s) { Json j; j.type = STR; j.string = s; return j; }
  static Json num(double n) { Json j; j.type = NUM; j.number = n; return j; }
  static Json boolean_value(bool b) { Json j; j.type = BOOL; j.boolean = b; return j; }

  const Json& operator[](const std::string& key) const {
    static const Json empty;
    auto it = object.find(key);
    return it == object.end() ? empty : it->second;
  }
  bool has(const std::string& key) const { return object.find(key) != object.end(); }
  std::string as_string(const std::string& fallback = "") const {
    return type == STR ? string : fallback;
  }
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& text) : text_(text) {}

  bool parse(Json& out, std::string& error) {
    skip_ws();
    if (!parse_value(out, error)) return false;
    skip_ws();
    if (pos_ != text_.size()) {
      error = "trailing characters at offset " + std::to_string(pos_);
      return false;
    }
    return true;
  }

 private:
  const std::string& text_;
  size_t pos_ = 0;

  void skip_ws() {
    while (pos_ < text_.size() &&
           (text_[pos_] == ' ' || text_[pos_] == '\t' || text_[pos_] == '\r' || text_[pos_] == '\n'))
      ++pos_;
  }

  bool parse_value(Json& out, std::string& error) {
    skip_ws();
    if (pos_ >= text_.size()) { error = "unexpected end of json"; return false; }
    char c = text_[pos_];
    if (c == '{') return parse_object(out, error);
    if (c == '[') return parse_array(out, error);
    if (c == '"') { out.type = Json::STR; return parse_string(out.string, error); }
    if (c == 't' || c == 'f') return parse_bool(out, error);
    if (c == 'n') return parse_null(out, error);
    return parse_number(out, error);
  }

  bool parse_object(Json& out, std::string& error) {
    out = Json::obj();
    ++pos_;  // {
    skip_ws();
    if (pos_ < text_.size() && text_[pos_] == '}') { ++pos_; return true; }
    while (true) {
      skip_ws();
      if (pos_ >= text_.size() || text_[pos_] != '"') { error = "expected object key"; return false; }
      std::string key;
      if (!parse_string(key, error)) return false;
      skip_ws();
      if (pos_ >= text_.size() || text_[pos_] != ':') { error = "expected ':'"; return false; }
      ++pos_;
      Json value;
      if (!parse_value(value, error)) return false;
      out.object[key] = value;
      skip_ws();
      if (pos_ >= text_.size()) { error = "unterminated object"; return false; }
      if (text_[pos_] == ',') { ++pos_; continue; }
      if (text_[pos_] == '}') { ++pos_; return true; }
      error = "expected ',' or '}'";
      return false;
    }
  }

  bool parse_array(Json& out, std::string& error) {
    out = Json::arr();
    ++pos_;  // [
    skip_ws();
    if (pos_ < text_.size() && text_[pos_] == ']') { ++pos_; return true; }
    while (true) {
      Json value;
      if (!parse_value(value, error)) return false;
      out.array.push_back(value);
      skip_ws();
      if (pos_ >= text_.size()) { error = "unterminated array"; return false; }
      if (text_[pos_] == ',') { ++pos_; continue; }
      if (text_[pos_] == ']') { ++pos_; return true; }
      error = "expected ',' or ']'";
      return false;
    }
  }

  static void append_utf8(std::string& out, unsigned cp) {
    if (cp <= 0x7f) out.push_back(static_cast<char>(cp));
    else if (cp <= 0x7ff) {
      out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else {
      out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    }
  }

  bool parse_string(std::string& out, std::string& error) {
    ++pos_;  // opening quote
    out.clear();
    while (pos_ < text_.size()) {
      unsigned char c = static_cast<unsigned char>(text_[pos_++]);
      if (c == '"') return true;
      if (c != '\\') { out.push_back(static_cast<char>(c)); continue; }
      if (pos_ >= text_.size()) break;
      char esc = text_[pos_++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          if (pos_ + 4 > text_.size()) { error = "short unicode escape"; return false; }
          unsigned cp = 0;
          for (int i = 0; i < 4; ++i) {
            char h = text_[pos_++];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
            else { error = "bad unicode escape"; return false; }
          }
          append_utf8(out, cp);
          break;
        }
        default: error = "bad escape"; return false;
      }
    }
    error = "unterminated string";
    return false;
  }

  bool parse_bool(Json& out, std::string& error) {
    if (text_.compare(pos_, 4, "true") == 0) { pos_ += 4; out = Json::boolean_value(true); return true; }
    if (text_.compare(pos_, 5, "false") == 0) { pos_ += 5; out = Json::boolean_value(false); return true; }
    error = "bad literal";
    return false;
  }

  bool parse_null(Json& out, std::string& error) {
    if (text_.compare(pos_, 4, "null") == 0) { pos_ += 4; out = Json(); return true; }
    error = "bad literal";
    return false;
  }

  bool parse_number(Json& out, std::string& error) {
    size_t start = pos_;
    if (pos_ < text_.size() && (text_[pos_] == '-' || text_[pos_] == '+')) ++pos_;
    while (pos_ < text_.size() && (isdigit(static_cast<unsigned char>(text_[pos_])) || text_[pos_] == '.' ||
                                   text_[pos_] == 'e' || text_[pos_] == 'E' || text_[pos_] == '-' ||
                                   text_[pos_] == '+'))
      ++pos_;
    if (pos_ == start) { error = "expected value"; return false; }
    try {
      out = Json::num(std::stod(text_.substr(start, pos_ - start)));
    } catch (...) {
      error = "bad number";
      return false;
    }
    return true;
  }
};

static void json_escape(std::string& out, const std::string& s) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

static void json_write(std::string& out, const Json& j) {
  switch (j.type) {
    case Json::NUL: out += "null"; break;
    case Json::BOOL: out += j.boolean ? "true" : "false"; break;
    case Json::NUM: {
      char buf[64];
      if (j.number == static_cast<double>(static_cast<long long>(j.number)) &&
          std::abs(j.number) < 1e15)
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(j.number));
      else
        std::snprintf(buf, sizeof(buf), "%.6f", j.number);
      out += buf;
      break;
    }
    case Json::STR: json_escape(out, j.string); break;
    case Json::ARR: {
      out.push_back('[');
      for (size_t i = 0; i < j.array.size(); ++i) {
        if (i) out.push_back(',');
        json_write(out, j.array[i]);
      }
      out.push_back(']');
      break;
    }
    case Json::OBJ: {
      out.push_back('{');
      bool first = true;
      for (const auto& kv : j.object) {
        if (!first) out.push_back(',');
        first = false;
        json_escape(out, kv.first);
        out.push_back(':');
        json_write(out, kv.second);
      }
      out.push_back('}');
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Addon state. Every call runs on a libuv worker thread and is serialized by
// g_engine_mutex, matching the old single-threaded sidecar request loop.
// ---------------------------------------------------------------------------

struct TorrentEntry {
  lt::torrent_handle handle;
  std::string save_dir;
  std::string name;
  bool is_magnet = false;
  int upload_limit_kbps = 0;
  int download_limit_kbps = 0;
};

static std::unique_ptr<lt::session> g_session;
static std::map<std::string, TorrentEntry> g_torrents;
static std::deque<std::string> g_alerts;
static int g_sessionUploadBytes = 0;
static int g_sessionDownloadBytes = 0;
static std::mutex g_engine_mutex;

static int kbps_to_torrent_bytes(double kbps) {
  return kbps <= 0 ? -1 : static_cast<int>(kbps * 1000.0 / 8.0);
}

static int kbps_to_session_bytes(double kbps) {
  return kbps <= 0 ? 0 : static_cast<int>(kbps * 1000.0 / 8.0);
}

static lt::settings_pack base_settings_pack() {
  lt::settings_pack pack;
  pack.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:6881");
  pack.set_int(lt::settings_pack::alert_mask, 0x7fffffff);
  pack.set_int(lt::settings_pack::alert_queue_size, 4000);
  pack.set_bool(lt::settings_pack::enable_dht, true);
  pack.set_str(lt::settings_pack::dht_bootstrap_nodes,
               "router.bittorrent.com:6881,router.utorrent.com:6881,dht.transmissionbt.com:6881");
  pack.set_int(lt::settings_pack::upload_rate_limit, g_sessionUploadBytes);
  pack.set_int(lt::settings_pack::download_rate_limit, g_sessionDownloadBytes);
  // A tiny upload cap should not starve the download: count only payload bytes
  // against the cap, and keep a fixed number of unchoke slots instead of the
  // rate-based choker, which opens fewer slots when upload is very low.
  pack.set_bool(lt::settings_pack::rate_limit_ip_overhead, false);
  pack.set_int(lt::settings_pack::choking_algorithm, lt::settings_pack::fixed_slots_choker);
  pack.set_int(lt::settings_pack::unchoke_slots_limit, 8);
  pack.set_int(lt::settings_pack::num_optimistic_unchoke_slots, 2);
  return pack;
}

static bool create_session(const std::string& listen_csv, const std::string& outgoing_csv, std::string& why) {
  lt::settings_pack pack = base_settings_pack();
  if (!listen_csv.empty()) pack.set_str(lt::settings_pack::listen_interfaces, listen_csv);
  if (!outgoing_csv.empty()) pack.set_str(lt::settings_pack::outgoing_interfaces, outgoing_csv);
  try {
    g_session = std::make_unique<lt::session>(pack);
  } catch (const std::exception& e) {
    why = std::string("session construction threw: ") + e.what();
    return false;
  }
  return true;
}

static void ensure_session() {
  if (!g_session) {
    std::string why;
    if (!create_session("", "", why)) throw std::runtime_error(why);
  }
}

static void add_alert_line(const std::string& line) {
  g_alerts.push_back(line);
  while (g_alerts.size() > 400) g_alerts.pop_front();
  std::fprintf(stderr, "[alert] %s\n", line.c_str());
  std::fflush(stderr);
}

static std::string hex_hash(const lt::sha1_hash& h) {
  static const char* digits = "0123456789abcdef";
  const auto* p = reinterpret_cast<const unsigned char*>(h.data());
  std::string out;
  out.reserve(40);
  for (int i = 0; i < 20; ++i) {
    out.push_back(digits[p[i] >> 4]);
    out.push_back(digits[p[i] & 0xf]);
  }
  return out;
}

static std::string hex_hash256(const lt::sha256_hash& h) {
  static const char* digits = "0123456789abcdef";
  const auto* p = reinterpret_cast<const unsigned char*>(h.data());
  std::string out;
  out.reserve(64);
  for (int i = 0; i < 32; ++i) {
    out.push_back(digits[p[i] >> 4]);
    out.push_back(digits[p[i] & 0xf]);
  }
  return out;
}

static std::string info_hash_hex(const lt::info_hash_t& ih) {
  if (!ih.v1.is_all_zeros()) return hex_hash(ih.v1);
  if (!ih.v2.is_all_zeros()) return hex_hash256(ih.v2);
  return "";
}

static const char* state_name(lt::torrent_status::state_t s) {
  switch (s) {
    case lt::torrent_status::checking_files: return "checking_files";
    case lt::torrent_status::downloading_metadata: return "downloading_metadata";
    case lt::torrent_status::downloading: return "downloading";
    case lt::torrent_status::finished: return "finished";
    case lt::torrent_status::seeding: return "seeding";
    case lt::torrent_status::checking_resume_data: return "checking_resume_data";
    default: return "unknown";
  }
}

static void record_alert(const lt::alert* a) {
  switch (a->type()) {
    case lt::listen_failed_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::listen_failed_alert>(a);
      add_alert_line("listen_failed: " + x->message());
      break;
    }
    case lt::listen_succeeded_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::listen_succeeded_alert>(a);
      add_alert_line("listen_succeeded: " + x->message());
      break;
    }
    case lt::peer_blocked_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::peer_blocked_alert>(a);
      add_alert_line("peer_blocked: " + x->message());
      break;
    }
    case lt::torrent_error_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::torrent_error_alert>(a);
      add_alert_line("torrent_error: " + x->message());
      break;
    }
    case lt::tracker_error_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::tracker_error_alert>(a);
      add_alert_line("tracker_error: " + x->message());
      break;
    }
    case lt::tracker_reply_alert::alert_type: {
      const auto* x = lt::alert_cast<lt::tracker_reply_alert>(a);
      add_alert_line("tracker_reply: " + std::to_string(x->num_peers) + " peers");
      break;
    }
    case lt::metadata_received_alert::alert_type:
      add_alert_line("metadata_received");
      break;
    default:
      break;
  }
}

static void pump_alerts(int milliseconds) {
  if (!g_session) return;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
  do {
    std::vector<lt::alert*> alerts;
    g_session->pop_alerts(&alerts);
    for (const auto* a : alerts) record_alert(a);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  } while (std::chrono::steady_clock::now() < deadline);
}

static Json last_alerts() {
  Json out = Json::arr();
  size_t start = g_alerts.size() > 40 ? g_alerts.size() - 40 : 0;
  for (size_t i = start; i < g_alerts.size(); ++i) out.array.push_back(Json::str(g_alerts[i]));
  return out;
}

// ---------------------------------------------------------------------------
// RPC implementations
// ---------------------------------------------------------------------------

static TorrentEntry* find_torrent(const std::string& info_hash, std::string& error) {
  auto it = g_torrents.find(info_hash);
  if (it == g_torrents.end()) {
    error = info_hash.empty() ? "infoHash is required" : "unknown infoHash";
    return nullptr;
  }
  return &it->second;
}

static Json files_json(const lt::torrent_handle& handle, const lt::torrent_status& st) {
  Json out = Json::arr();
  auto tf = st.torrent_file.lock();
  if (!tf) return out;

  std::vector<std::int64_t> progress;
  handle.file_progress(progress, lt::torrent_handle::piece_granularity);
  std::vector<lt::download_priority_t> priorities;
  try {
    priorities = handle.get_file_priorities();
  } catch (...) {
    priorities.clear();
  }

  auto const& fs = tf->files();
  const int count = tf->num_files();
  for (int i = 0; i < count; ++i) {
    Json file = Json::obj();
    file.object["index"] = Json::num(i);
    file.object["name"] = Json::str(fs.file_path(lt::file_index_t(i)));
    file.object["size"] = Json::num(static_cast<double>(fs.file_size(lt::file_index_t(i))));
    file.object["downloaded"] = Json::num(
        i < static_cast<int>(progress.size()) ? static_cast<double>(progress[i]) : 0.0);
    int priority = 4;
    if (i < static_cast<int>(priorities.size())) {
      priority = static_cast<int>(static_cast<std::uint8_t>(priorities[i]));
    }
    file.object["priority"] = Json::num(priority);
    out.array.push_back(file);
  }
  return out;
}

static Json rpc_start_torrent(const Json& params) {
  Json result = Json::obj();
  std::string torrent = params["torrent"].as_string();
  std::string save_dir = params["saveDir"].as_string();
  if (torrent.empty() || save_dir.empty()) {
    result.object["error"] = Json::str("torrent and saveDir are required");
    return result;
  }

  std::error_code fs_ec;
  std::filesystem::create_directories(std::filesystem::u8path(save_dir), fs_ec);

  lt::error_code ec;
  lt::add_torrent_params atp;
  bool is_magnet = torrent.rfind("magnet:", 0) == 0;
  if (is_magnet) {
    lt::parse_magnet_uri(torrent, atp, ec);
    if (ec) {
      result.object["error"] = Json::str("magnet parse failed: " + ec.message());
      return result;
    }
  } else {
    atp.ti = std::make_shared<lt::torrent_info>(torrent, ec);
    if (ec) {
      result.object["error"] = Json::str("torrent load failed: " + ec.message());
      return result;
    }
  }
  atp.save_path = save_dir;

  // Adding the same torrent twice is not an error: the app may see a bridge
  // request and a .torrent association for the same info hash.
  std::string known_hash = info_hash_hex(atp.info_hashes);
  if (!known_hash.empty()) {
    auto existing = g_torrents.find(known_hash);
    if (existing != g_torrents.end()) {
      result.object["infoHash"] = Json::str(known_hash);
      result.object["name"] = Json::str(existing->second.name);
      result.object["isMagnet"] = Json::boolean_value(existing->second.is_magnet);
      result.object["saveDir"] = Json::str(existing->second.save_dir);
      result.object["existing"] = Json::boolean_value(true);
      return result;
    }
  }

  try {
    ensure_session();
  } catch (const std::exception& e) {
    result.object["error"] = Json::str(e.what());
    return result;
  }

  lt::torrent_handle h = g_session->add_torrent(atp, ec);
  if (ec) {
    result.object["error"] = Json::str("add_torrent failed: " + ec.message());
    return result;
  }
  std::string info_hash = info_hash_hex(h.info_hashes());
  if (info_hash.empty()) info_hash = known_hash;
  if (info_hash.empty()) {
    result.object["error"] = Json::str("could not determine info hash");
    return result;
  }

  std::string name = atp.ti ? atp.ti->name() : atp.name;
  if (name.empty()) name = is_magnet ? "Magnet link" : "Torrent";

  TorrentEntry entry;
  entry.handle = h;
  entry.save_dir = save_dir;
  entry.name = name;
  entry.is_magnet = is_magnet;
  g_torrents[info_hash] = entry;

  // A fresh handle starts unlimited. Re-apply the limits stored for this
  // entry (zero means unlimited at the handle level; the app applies the
  // global/per-torrent values again as soon as it knows the row).
  h.set_upload_limit(kbps_to_torrent_bytes(entry.upload_limit_kbps));
  h.set_download_limit(kbps_to_torrent_bytes(entry.download_limit_kbps));

  result.object["infoHash"] = Json::str(info_hash);
  result.object["name"] = Json::str(name);
  result.object["isMagnet"] = Json::boolean_value(is_magnet);
  result.object["saveDir"] = Json::str(save_dir);
  return result;
}

static Json rpc_status(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  if (want.empty()) {
    if (g_torrents.empty()) {
      result.object["error"] = Json::str("no torrent started");
      return result;
    }
    if (g_torrents.size() > 1) {
      result.object["error"] = Json::str("infoHash is required");
      return result;
    }
    want = g_torrents.begin()->first;
  }
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  if (!entry->handle.is_valid()) {
    result.object["error"] = Json::str("torrent handle is no longer valid");
    return result;
  }

  lt::torrent_status st = entry->handle.status(
      lt::torrent_handle::query_accurate_download_counters | lt::torrent_handle::query_torrent_file |
      lt::torrent_handle::query_name | lt::torrent_handle::query_save_path);
  int total_pieces = 0;
  if (auto tf = st.torrent_file.lock()) total_pieces = tf->num_pieces();

  const std::int64_t remaining_wanted =
      st.total_wanted > st.total_wanted_done ? st.total_wanted - st.total_wanted_done : 0;
  int eta_seconds = -1;
  if (remaining_wanted == 0) {
    eta_seconds = 0;
  } else if (st.download_rate > 0) {
    eta_seconds = static_cast<int>((remaining_wanted + st.download_rate - 1) / st.download_rate);
  }
  auto limit_kbps = [](int bytes_per_second) {
    return bytes_per_second < 0 ? 0.0 : bytes_per_second * 8.0 / 1000.0;
  };

  result.object["infoHash"] = Json::str(want);
  result.object["name"] = Json::str(!st.name.empty() ? st.name : entry->name);
  result.object["saveDir"] = Json::str(entry->save_dir);
  result.object["isMagnet"] = Json::boolean_value(entry->is_magnet);
  result.object["progress"] = Json::num(st.progress);
  result.object["downKbps"] = Json::num(st.download_rate * 8.0 / 1000.0);
  result.object["upKbps"] = Json::num(st.upload_rate * 8.0 / 1000.0);
  result.object["uploadPayloadKbps"] = Json::num(st.upload_payload_rate * 8.0 / 1000.0);
  result.object["downloadPayloadKbps"] = Json::num(st.download_payload_rate * 8.0 / 1000.0);
  result.object["peers"] = Json::num(st.num_peers);
  result.object["seeds"] = Json::num(st.num_seeds);
  result.object["pieces"] = Json::num(st.num_pieces);
  result.object["piecesTotal"] = Json::num(total_pieces);
  result.object["state"] = Json::str(state_name(st.state));
  result.object["error"] = Json::str(st.errc ? st.errc.message() : "");
  result.object["totalDone"] = Json::num(static_cast<double>(st.total_done));
  result.object["totalWanted"] = Json::num(static_cast<double>(st.total_wanted));
  result.object["totalWantedDone"] = Json::num(static_cast<double>(st.total_wanted_done));
  result.object["uploaded"] = Json::num(static_cast<double>(st.total_upload));
  result.object["allTimeUpload"] = Json::num(static_cast<double>(st.all_time_upload));
  result.object["allTimeDownload"] = Json::num(static_cast<double>(st.all_time_download));
  result.object["etaSeconds"] = Json::num(eta_seconds);
  result.object["currentTracker"] = Json::str(st.current_tracker);
  result.object["nextAnnounceSec"] = Json::num(static_cast<double>(
      std::chrono::duration_cast<std::chrono::seconds>(st.next_announce).count()));
  result.object["numComplete"] = Json::num(st.num_complete);
  result.object["numIncomplete"] = Json::num(st.num_incomplete);
  result.object["listPeers"] = Json::num(st.list_peers);
  result.object["distributedCopies"] = Json::num(st.distributed_copies);
  result.object["numConnections"] = Json::num(st.num_connections);
  result.object["numUploads"] = Json::num(st.num_uploads);
  result.object["activeSeconds"] = Json::num(static_cast<double>(st.active_duration.count()));
  result.object["seedingSeconds"] = Json::num(static_cast<double>(st.seeding_duration.count()));
  result.object["uploadLimitKbps"] = Json::num(limit_kbps(entry->handle.upload_limit()));
  result.object["downloadLimitKbps"] = Json::num(limit_kbps(entry->handle.download_limit()));
  result.object["files"] = files_json(entry->handle, st);
  result.object["alerts"] = last_alerts();
  return result;
}

static Json rpc_set_file_priorities(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  if (params["priorities"].type != Json::ARR) {
    result.object["error"] = Json::str("priorities must be an array");
    return result;
  }

  lt::torrent_status st = entry->handle.status(lt::torrent_handle::query_torrent_file);
  auto tf = st.torrent_file.lock();
  if (!tf) {
    result.object["error"] = Json::str("metadata not available yet");
    return result;
  }

  const int count = tf->num_files();
  if (static_cast<int>(params["priorities"].array.size()) != count) {
    result.object["error"] = Json::str("expected " + std::to_string(count) + " priorities");
    return result;
  }
  std::vector<lt::download_priority_t> priorities;
  priorities.reserve(count);
  for (const auto& v : params["priorities"].array) {
    int p = v.type == Json::NUM ? static_cast<int>(v.number) : 4;
    if (p < 0) p = 0;
    if (p > 7) p = 7;
    priorities.push_back(lt::download_priority_t{static_cast<std::uint8_t>(p)});
  }
  try {
    entry->handle.prioritize_files(priorities);
  } catch (const std::exception& e) {
    result.object["error"] = Json::str(std::string("prioritize_files failed: ") + e.what());
    return result;
  }
  result.object["applied"] = Json::boolean_value(true);
  result.object["infoHash"] = Json::str(want);
  result.object["files"] = files_json(entry->handle, st);
  return result;
}

static Json rpc_set_limits(const Json& params) {
  Json result = Json::obj();
  const double upload_kbps = params["uploadKbps"].type == Json::NUM ? params["uploadKbps"].number : 0.0;
  const double download_kbps = params["downloadKbps"].type == Json::NUM ? params["downloadKbps"].number : 0.0;
  const int upload_bytes = kbps_to_torrent_bytes(upload_kbps);
  const int download_bytes = kbps_to_torrent_bytes(download_kbps);
  std::string want = params["infoHash"].as_string();
  int applied = 0;

  auto apply = [&](const std::string&, TorrentEntry& entry) {
    entry.handle.set_upload_limit(upload_bytes);
    entry.handle.set_download_limit(download_bytes);
    entry.upload_limit_kbps = upload_kbps > 0 ? static_cast<int>(upload_kbps) : 0;
    entry.download_limit_kbps = download_kbps > 0 ? static_cast<int>(download_kbps) : 0;
    ++applied;
  };

  if (want.empty()) {
    for (auto& kv : g_torrents) apply(kv.first, kv.second);
  } else {
    std::string lookup_error;
    TorrentEntry* entry = find_torrent(want, lookup_error);
    if (!entry) {
      result.object["error"] = Json::str(lookup_error);
      return result;
    }
    apply(want, *entry);
  }
  result.object["applied"] = Json::num(applied);
  result.object["uploadKbps"] = Json::num(upload_kbps);
  result.object["downloadKbps"] = Json::num(download_kbps);
  return result;
}

static Json rpc_set_session_limits(const Json& params) {
  Json result = Json::obj();
  if (params["uploadKbps"].type == Json::NUM) {
    g_sessionUploadBytes = kbps_to_session_bytes(params["uploadKbps"].number);
  }
  if (params["downloadKbps"].type == Json::NUM) {
    g_sessionDownloadBytes = kbps_to_session_bytes(params["downloadKbps"].number);
  }
  if (g_session) {
    lt::settings_pack pack;
    pack.set_int(lt::settings_pack::upload_rate_limit, g_sessionUploadBytes);
    pack.set_int(lt::settings_pack::download_rate_limit, g_sessionDownloadBytes);
    try {
      g_session->apply_settings(pack);
    } catch (const std::exception& e) {
      result.object["error"] = Json::str(std::string("apply_settings failed: ") + e.what());
      return result;
    }
  }
  result.object["applied"] = Json::boolean_value(true);
  result.object["uploadKbps"] = Json::num(g_sessionUploadBytes * 8.0 / 1000.0);
  result.object["downloadKbps"] = Json::num(g_sessionDownloadBytes * 8.0 / 1000.0);
  return result;
}

static Json rpc_peer_list(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  if (!entry->handle.is_valid()) {
    result.object["error"] = Json::str("torrent handle is no longer valid");
    return result;
  }

  std::vector<lt::peer_info> peers;
  try {
    entry->handle.get_peer_info(peers);
  } catch (const std::exception& e) {
    result.object["error"] = Json::str(std::string("get_peer_info failed: ") + e.what());
    return result;
  }

  // get_peer_info() also returns half-open connection attempts. Put established
  // peers first so the list reads like a uTorrent peer window.
  auto connected = [](const lt::peer_info& p) {
    return !static_cast<bool>(p.flags & lt::peer_info::connecting) &&
           !static_cast<bool>(p.flags & lt::peer_info::handshake);
  };
  std::sort(peers.begin(), peers.end(), [&](const lt::peer_info& a, const lt::peer_info& b) {
    const bool a_connected = connected(a);
    const bool b_connected = connected(b);
    if (a_connected != b_connected) return a_connected;
    return (a.down_speed + a.up_speed) > (b.down_speed + b.up_speed);
  });

  Json list = Json::arr();
  for (const auto& p : peers) {
    Json peer = Json::obj();
    peer.object["ip"] = Json::str(p.ip.address().to_string());
    peer.object["port"] = Json::num(p.ip.port());
    peer.object["localAddress"] = Json::str(
        p.local_endpoint.address().to_string() + ":" + std::to_string(p.local_endpoint.port()));
    peer.object["client"] = Json::str(p.client);
    peer.object["downKbps"] = Json::num(p.down_speed * 8.0 / 1000.0);
    peer.object["upKbps"] = Json::num(p.up_speed * 8.0 / 1000.0);
    peer.object["progress"] = Json::num(p.progress);
    peer.object["pieces"] = Json::num(p.num_pieces);
    peer.object["seed"] = Json::boolean_value(static_cast<bool>(p.flags & lt::peer_info::seed));
    peer.object["source"] = Json::num(static_cast<int>(static_cast<std::uint8_t>(p.source)));
    peer.object["flags"] = Json::num(static_cast<double>(static_cast<std::uint32_t>(p.flags)));
    peer.object["rtt"] = Json::num(p.rtt);
    peer.object["totalDownload"] = Json::num(static_cast<double>(p.total_download));
    peer.object["totalUpload"] = Json::num(static_cast<double>(p.total_upload));
    peer.object["connectionType"] =
        Json::num(static_cast<int>(static_cast<std::uint8_t>(p.connection_type)));
    list.array.push_back(peer);
  }
  result.object["infoHash"] = Json::str(want);
  result.object["peers"] = list;
  return result;
}

static Json rpc_update_trackers(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  if (!entry->handle.is_valid()) {
    result.object["error"] = Json::str("torrent handle is no longer valid");
    return result;
  }
  try {
    // 0 seconds means "now", but libtorrent still respects each tracker's
    // min_interval so repeated clicks do not get the client rate-limited.
    entry->handle.force_reannounce(0, -1);
    entry->handle.scrape_tracker();
  } catch (const std::exception& e) {
    result.object["error"] = Json::str(std::string("tracker update failed: ") + e.what());
    return result;
  }
  result.object["reannounced"] = Json::boolean_value(true);
  result.object["scraped"] = Json::boolean_value(true);
  result.object["infoHash"] = Json::str(want);
  return result;
}

static Json rpc_pause_torrent(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  entry->handle.pause();
  result.object["paused"] = Json::boolean_value(true);
  result.object["infoHash"] = Json::str(want);
  return result;
}

static Json rpc_resume_torrent(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  entry->handle.resume();
  result.object["resumed"] = Json::boolean_value(true);
  result.object["infoHash"] = Json::str(want);
  return result;
}

static Json rpc_remove_torrent(const Json& params) {
  Json result = Json::obj();
  std::string want = params["infoHash"].as_string();
  std::string lookup_error;
  TorrentEntry* entry = find_torrent(want, lookup_error);
  if (!entry) {
    result.object["error"] = Json::str(lookup_error);
    return result;
  }
  bool delete_files = params["deleteFiles"].type == Json::BOOL && params["deleteFiles"].boolean;
  if (g_session) {
    g_session->remove_torrent(
        entry->handle, delete_files ? lt::session::delete_files : lt::remove_flags_t{});
  }
  g_torrents.erase(want);
  result.object["removed"] = Json::boolean_value(true);
  result.object["deletedFiles"] = Json::boolean_value(delete_files);
  result.object["infoHash"] = Json::str(want);
  return result;
}

static bool configure_interfaces(const std::vector<std::string>& devices,
                                 const std::vector<int>& ports,
                                 const std::string& phrase,
                                 std::string& applied_listen,
                                 std::string& applied_outgoing,
                                 std::string& why) {
  std::string listen_csv;
  std::string outgoing_csv;
  for (size_t i = 0; i < devices.size(); ++i) {
    if (i) {
      listen_csv += ",";
      outgoing_csv += ",";
    }
    listen_csv += devices[i] + ":" + std::to_string(ports[i]);
    outgoing_csv += devices[i];
  }

  applied_listen = listen_csv;
  applied_outgoing = outgoing_csv;

  bool created = false;
  if (!g_session) {
    // The reliable Windows path: configure interfaces when the session is
    // constructed. Applying listen settings to an already-running session can
    // leave DHT unable to find peers (observed with libtorrent 2.0.11).
    if (!create_session(listen_csv, outgoing_csv, why)) return false;
    created = true;
  } else {
    // Drop queued alerts from earlier settings so success detection below only
    // looks at this attempt.
    std::vector<lt::alert*> stale;
    g_session->pop_alerts(&stale);
    for (const auto* a : stale) record_alert(a);

    lt::settings_pack pack;
    pack.set_str(lt::settings_pack::listen_interfaces, listen_csv);
    pack.set_str(lt::settings_pack::outgoing_interfaces, outgoing_csv);
    try {
      g_session->apply_settings(pack);
    } catch (const std::exception& e) {
      why = std::string("apply_settings threw: ") + e.what();
      return false;
    }
  }

  // Wait briefly, then check that every requested device actually produced a
  // listen success on that specific address. Accepting 0.0.0.0 as success for a
  // named device would hide a silent fallback, so reject it.
  auto deadline = std::chrono::steady_clock::now() +
                  std::chrono::milliseconds(created ? 2500 : 1500);
  std::vector<std::string> succeeded;
  std::vector<std::string> failed;
  do {
    std::vector<lt::alert*> alerts;
    g_session->pop_alerts(&alerts);
    for (const auto* a : alerts) {
      record_alert(a);
      if (a->type() == lt::listen_succeeded_alert::alert_type) {
        const auto* ls = lt::alert_cast<lt::listen_succeeded_alert>(a);
        succeeded.push_back(ls->address.to_string() + ":" + std::to_string(ls->port));
      } else if (a->type() == lt::listen_failed_alert::alert_type) {
        failed.push_back(lt::alert_cast<lt::listen_failed_alert>(a)->message());
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  } while (std::chrono::steady_clock::now() < deadline);

  auto fail = [&](const std::string& message) {
    why = message;
    if (created) g_session.reset();
    return false;
  };

  if (!failed.empty()) return fail(phrase + ": listen_failed_alert: " + failed.front());
  if (succeeded.empty()) return fail(phrase + ": no listen_succeeded_alert");
  for (const auto& addr : devices) {
    bool ok = false;
    for (const auto& s : succeeded) {
      if (s.rfind(addr + ":", 0) == 0) { ok = true; break; }
    }
    if (!ok) {
      return fail(phrase + ": no listen success for " + addr + " (got " + succeeded.front() + ")");
    }
  }
  return true;
}

// GUID binding is probed in a throwaway session. Attempting it in the live
// session and then re-applying IP settings leaves libtorrent's DHT unable to
// find peers (observed on Windows with libtorrent 2.0.11), so the probe must
// not touch the real session.
static bool probe_guid_binding(const std::vector<std::string>& addresses,
                               const std::vector<std::string>& guids,
                               std::string& why) {
  std::string listen_csv;
  std::string outgoing_csv;
  for (size_t i = 0; i < guids.size(); ++i) {
    if (i) {
      listen_csv += ",";
      outgoing_csv += ",";
    }
    listen_csv += guids[i] + ":0";
    outgoing_csv += guids[i];
  }

  try {
    lt::settings_pack pack;
    pack.set_str(lt::settings_pack::listen_interfaces, listen_csv);
    pack.set_str(lt::settings_pack::outgoing_interfaces, outgoing_csv);
    pack.set_int(lt::settings_pack::alert_mask, 0x7fffffff);
    pack.set_bool(lt::settings_pack::enable_dht, false);
    pack.set_bool(lt::settings_pack::enable_lsd, false);
    pack.set_bool(lt::settings_pack::enable_upnp, false);
    pack.set_bool(lt::settings_pack::enable_natpmp, false);
    lt::session probe(pack);

    std::vector<std::string> succeeded;
    std::vector<std::string> failed;
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
    do {
      std::vector<lt::alert*> alerts;
      probe.pop_alerts(&alerts);
      for (const auto* a : alerts) {
        if (a->type() == lt::listen_succeeded_alert::alert_type) {
          const auto* ls = lt::alert_cast<lt::listen_succeeded_alert>(a);
          succeeded.push_back(ls->address.to_string() + ":" + std::to_string(ls->port));
        } else if (a->type() == lt::listen_failed_alert::alert_type) {
          failed.push_back(lt::alert_cast<lt::listen_failed_alert>(a)->message());
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    } while (std::chrono::steady_clock::now() < deadline);
    probe.abort();

    if (!failed.empty()) {
      why = "guid binding failed: " + failed.front();
      return false;
    }
    if (succeeded.empty()) {
      why = "guid binding produced no listen success";
      return false;
    }
    for (const auto& addr : addresses) {
      bool ok = false;
      for (const auto& s : succeeded) {
        if (s.rfind(addr + ":", 0) == 0) { ok = true; break; }
      }
      if (!ok) {
        why = "guid binding did not expose " + addr + " (got " + succeeded.front() + ")";
        return false;
      }
    }
    return true;
  } catch (const std::exception& e) {
    why = std::string("guid binding threw: ") + e.what();
    return false;
  }
}

static Json rpc_set_interfaces(const Json& params) {
  Json result = Json::obj();
  std::vector<std::string> addresses;
  std::vector<std::string> guids;
  if (params["addresses"].type == Json::ARR) {
    for (const auto& v : params["addresses"].array) {
      if (v.type == Json::STR) addresses.push_back(v.string);
    }
  }
  if (params["guids"].type == Json::ARR) {
    for (const auto& v : params["guids"].array) {
      if (v.type == Json::STR) guids.push_back(v.string);
    }
  }
  if (addresses.empty()) {
    result.object["error"] = Json::str("addresses must be a non-empty array");
    return result;
  }
  int base_port = 6881;
  if (params["port"].type == Json::NUM) base_port = static_cast<int>(params["port"].number);
  std::vector<int> ports;
  for (size_t i = 0; i < addresses.size(); ++i) ports.push_back(base_port + static_cast<int>(i));

  std::string listen_csv, outgoing_csv, why;
  bool used_guid = false;
  if (guids.size() == addresses.size()) {
    // Preferred per spec: bind listeners by adapter GUID if libtorrent/Windows
    // supports it. Expected to fail on Windows; fall back to IP:port.
    if (probe_guid_binding(addresses, guids, why)) {
      std::string guid_listen, guid_outgoing, guid_why;
      if (configure_interfaces(guids, ports, "guid binding", guid_listen, guid_outgoing, guid_why)) {
        used_guid = true;
        listen_csv = guid_listen;
        outgoing_csv = guid_outgoing;
      } else {
        why = guid_why;
      }
    }
  }

  if (!used_guid) {
    std::string ip_why;
    if (!configure_interfaces(addresses, ports, "ip binding", listen_csv, outgoing_csv, ip_why)) {
      result.object["error"] = Json::str(ip_why + (why.empty() ? "" : ("; guid attempt: " + why)));
      result.object["listenInterfaces"] = Json::str(listen_csv);
      result.object["outgoingInterfaces"] = Json::str(outgoing_csv);
      result.object["alerts"] = last_alerts();
      return result;
    }
  }

  Json port_list = Json::arr();
  for (int p : ports) port_list.array.push_back(Json::num(p));

  result.object["method"] = Json::str(used_guid ? "guid" : "ip");
  result.object["listenInterfaces"] = Json::str(listen_csv);
  result.object["outgoingInterfaces"] = Json::str(outgoing_csv);
  result.object["ports"] = port_list;
  result.object["guidAttempt"] = Json::str(why);
  result.object["alerts"] = last_alerts();
  return result;
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

static Json dispatch_rpc(const Json& request) {
  Json response = Json::obj();
  std::string method = request["method"].as_string();
  Json params = request.has("params") ? request["params"] : Json::obj();

  Json result;
  bool ok = true;
  if (method == "startTorrent") {
    result = rpc_start_torrent(params);
  } else if (method == "status") {
    result = rpc_status(params);
  } else if (method == "setInterfaces") {
    result = rpc_set_interfaces(params);
  } else if (method == "setFilePriorities") {
    result = rpc_set_file_priorities(params);
  } else if (method == "setLimits") {
    result = rpc_set_limits(params);
  } else if (method == "setSessionLimits") {
    result = rpc_set_session_limits(params);
  } else if (method == "peerList") {
    result = rpc_peer_list(params);
  } else if (method == "updateTrackers") {
    result = rpc_update_trackers(params);
  } else if (method == "pauseTorrent") {
    result = rpc_pause_torrent(params);
  } else if (method == "resumeTorrent") {
    result = rpc_resume_torrent(params);
  } else if (method == "removeTorrent") {
    result = rpc_remove_torrent(params);
  } else if (method == "stop") {
    result = Json::obj();
    // The old sidecar process exited here. Mirror that: drop the session and
    // all handles so the next ensureEngine() starts from an empty engine.
    g_torrents.clear();
    g_alerts.clear();
    if (g_session) g_session.reset();
    result.object["stopped"] = Json::boolean_value(true);
  } else if (method == "ping") {
    result = Json::obj();
    result.object["pong"] = Json::boolean_value(true);
    result.object["version"] = Json::str(lt::version());
  } else {
    ok = false;
    response.object["error"] = Json::str("unknown method: " + method);
  }

  if (ok) {
    const std::string err = result.has("error") ? result["error"].as_string() : "";
    if (!err.empty()) {
      response.object["ok"] = Json::boolean_value(false);
      response.object["error"] = Json::str(err);
    } else {
      response.object["ok"] = Json::boolean_value(true);
    }
    response.object["result"] = result;
  }
  return response;
}

// ---------------------------------------------------------------------------
// N-API bridge
//
// The addon is loaded by the Electron main process, which exports the N-API
// entry points from its executable. MinGW builds have no import library for
// those exports, so every function pointer is resolved from the host module at
// registration time. node_api.h supplies type declarations only; the addon is
// not linked against node.lib or any other import library.
// ---------------------------------------------------------------------------

#include <node_api.h>

struct NapiApi {
  decltype(&napi_get_cb_info) get_cb_info = nullptr;
  decltype(&napi_create_function) create_function = nullptr;
  decltype(&napi_set_named_property) set_named_property = nullptr;
  decltype(&napi_create_string_utf8) create_string_utf8 = nullptr;
  decltype(&napi_create_object) create_object = nullptr;
  decltype(&napi_create_array_with_length) create_array_with_length = nullptr;
  decltype(&napi_get_boolean) get_boolean = nullptr;
  decltype(&napi_get_null) get_null = nullptr;
  decltype(&napi_get_undefined) get_undefined = nullptr;
  decltype(&napi_create_double) create_double = nullptr;
  decltype(&napi_set_element) set_element = nullptr;
  decltype(&napi_typeof) type_of = nullptr;
  decltype(&napi_get_value_bool) get_value_bool = nullptr;
  decltype(&napi_get_value_double) get_value_double = nullptr;
  decltype(&napi_get_value_string_utf8) get_value_string_utf8 = nullptr;
  decltype(&napi_is_array) is_array = nullptr;
  decltype(&napi_get_array_length) get_array_length = nullptr;
  decltype(&napi_get_element) get_element = nullptr;
  decltype(&napi_get_property_names) get_property_names = nullptr;
  decltype(&napi_get_named_property) get_named_property = nullptr;
  decltype(&napi_create_async_work) create_async_work = nullptr;
  decltype(&napi_delete_async_work) delete_async_work = nullptr;
  decltype(&napi_queue_async_work) queue_async_work = nullptr;
  decltype(&napi_create_promise) create_promise = nullptr;
  decltype(&napi_resolve_deferred) resolve_deferred = nullptr;
  decltype(&napi_reject_deferred) reject_deferred = nullptr;
  decltype(&napi_create_error) create_error = nullptr;
  decltype(&napi_throw_error) throw_error = nullptr;
};

static NapiApi g_napi;

template <typename T>
static bool load_napi_symbol(HMODULE host, T& target, const char* name) {
  target = reinterpret_cast<T>(GetProcAddress(host, name));
  return target != nullptr;
}

static bool load_napi_api() {
  HMODULE host = GetModuleHandleW(nullptr);
  if (!host) return false;
  bool ok = true;
  ok = load_napi_symbol(host, g_napi.get_cb_info, "napi_get_cb_info") && ok;
  ok = load_napi_symbol(host, g_napi.create_function, "napi_create_function") && ok;
  ok = load_napi_symbol(host, g_napi.set_named_property, "napi_set_named_property") && ok;
  ok = load_napi_symbol(host, g_napi.create_string_utf8, "napi_create_string_utf8") && ok;
  ok = load_napi_symbol(host, g_napi.create_object, "napi_create_object") && ok;
  ok = load_napi_symbol(host, g_napi.create_array_with_length, "napi_create_array_with_length") && ok;
  ok = load_napi_symbol(host, g_napi.get_boolean, "napi_get_boolean") && ok;
  ok = load_napi_symbol(host, g_napi.get_null, "napi_get_null") && ok;
  ok = load_napi_symbol(host, g_napi.get_undefined, "napi_get_undefined") && ok;
  ok = load_napi_symbol(host, g_napi.create_double, "napi_create_double") && ok;
  ok = load_napi_symbol(host, g_napi.set_element, "napi_set_element") && ok;
  ok = load_napi_symbol(host, g_napi.type_of, "napi_typeof") && ok;
  ok = load_napi_symbol(host, g_napi.get_value_bool, "napi_get_value_bool") && ok;
  ok = load_napi_symbol(host, g_napi.get_value_double, "napi_get_value_double") && ok;
  ok = load_napi_symbol(host, g_napi.get_value_string_utf8, "napi_get_value_string_utf8") && ok;
  ok = load_napi_symbol(host, g_napi.is_array, "napi_is_array") && ok;
  ok = load_napi_symbol(host, g_napi.get_array_length, "napi_get_array_length") && ok;
  ok = load_napi_symbol(host, g_napi.get_element, "napi_get_element") && ok;
  ok = load_napi_symbol(host, g_napi.get_property_names, "napi_get_property_names") && ok;
  ok = load_napi_symbol(host, g_napi.get_named_property, "napi_get_named_property") && ok;
  ok = load_napi_symbol(host, g_napi.create_async_work, "napi_create_async_work") && ok;
  ok = load_napi_symbol(host, g_napi.delete_async_work, "napi_delete_async_work") && ok;
  ok = load_napi_symbol(host, g_napi.queue_async_work, "napi_queue_async_work") && ok;
  ok = load_napi_symbol(host, g_napi.create_promise, "napi_create_promise") && ok;
  ok = load_napi_symbol(host, g_napi.resolve_deferred, "napi_resolve_deferred") && ok;
  ok = load_napi_symbol(host, g_napi.reject_deferred, "napi_reject_deferred") && ok;
  ok = load_napi_symbol(host, g_napi.create_error, "napi_create_error") && ok;
  ok = load_napi_symbol(host, g_napi.throw_error, "napi_throw_error") && ok;
  return ok;
}

// Recursive JS -> Json conversion for call(method, params).
static Json json_from_napi(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (!value || g_napi.type_of(env, value, &type) != napi_ok) return Json();
  switch (type) {
    case napi_boolean: {
      bool b = false;
      if (g_napi.get_value_bool(env, value, &b) != napi_ok) return Json();
      return Json::boolean_value(b);
    }
    case napi_number: {
      double d = 0.0;
      if (g_napi.get_value_double(env, value, &d) != napi_ok) return Json();
      return Json::num(d);
    }
    case napi_string: {
      size_t length = 0;
      if (g_napi.get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return Json();
      std::string text(length + 1, '\0');
      if (length) {
        if (g_napi.get_value_string_utf8(env, value, &text[0], length + 1, &length) != napi_ok) {
          return Json();
        }
        text.resize(length);
      } else {
        text.clear();
      }
      return Json::str(text);
    }
    case napi_object: {
      bool is_array = false;
      if (g_napi.is_array(env, value, &is_array) != napi_ok) return Json();
      if (is_array) {
        uint32_t length = 0;
        if (g_napi.get_array_length(env, value, &length) != napi_ok) return Json();
        Json out = Json::arr();
        out.array.reserve(length);
        for (uint32_t i = 0; i < length; ++i) {
          napi_value item = nullptr;
          if (g_napi.get_element(env, value, i, &item) != napi_ok) {
            out.array.push_back(Json());
            continue;
          }
          out.array.push_back(json_from_napi(env, item));
        }
        return out;
      }
      napi_value names = nullptr;
      Json out = Json::obj();
      if (g_napi.get_property_names(env, value, &names) != napi_ok) return out;
      uint32_t count = 0;
      if (g_napi.get_array_length(env, names, &count) != napi_ok) return out;
      for (uint32_t i = 0; i < count; ++i) {
        napi_value key_value = nullptr;
        if (g_napi.get_element(env, names, i, &key_value) != napi_ok) continue;
        Json key = json_from_napi(env, key_value);
        if (key.type != Json::STR) continue;
        napi_value item = nullptr;
        if (g_napi.get_named_property(env, value, key.string.c_str(), &item) != napi_ok) continue;
        out.object[key.string] = json_from_napi(env, item);
      }
      return out;
    }
    default:
      return Json();
  }
}

// Recursive Json -> JS conversion for replies.
static napi_value napi_from_json(napi_env env, const Json& value) {
  napi_value out = nullptr;
  switch (value.type) {
    case Json::NUL:
      if (g_napi.get_null(env, &out) != napi_ok) return nullptr;
      return out;
    case Json::BOOL:
      if (g_napi.get_boolean(env, value.boolean, &out) != napi_ok) return nullptr;
      return out;
    case Json::NUM:
      if (g_napi.create_double(env, value.number, &out) != napi_ok) return nullptr;
      return out;
    case Json::STR:
      if (g_napi.create_string_utf8(env, value.string.c_str(), value.string.size(), &out) != napi_ok) {
        return nullptr;
      }
      return out;
    case Json::ARR: {
      if (g_napi.create_array_with_length(env, value.array.size(), &out) != napi_ok) return nullptr;
      for (size_t i = 0; i < value.array.size(); ++i) {
        napi_value item = napi_from_json(env, value.array[i]);
        if (!item) return nullptr;
        if (g_napi.set_element(env, out, static_cast<uint32_t>(i), item) != napi_ok) return nullptr;
      }
      return out;
    }
    case Json::OBJ: {
      if (g_napi.create_object(env, &out) != napi_ok) return nullptr;
      for (const auto& kv : value.object) {
        napi_value item = napi_from_json(env, kv.second);
        if (!item) return nullptr;
        if (g_napi.set_named_property(env, out, kv.first.c_str(), item) != napi_ok) return nullptr;
      }
      return out;
    }
  }
  return nullptr;
}

struct CallWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string method;
  Json params;
  Json result;
  std::string error;
};

static void execute_call(napi_env /*env*/, void* data) {
  CallWork* work = static_cast<CallWork*>(data);
  try {
    Json request = Json::obj();
    request.object["method"] = Json::str(work->method);
    request.object["params"] = work->params;
    std::lock_guard<std::mutex> lock(g_engine_mutex);
    work->result = dispatch_rpc(request);
  } catch (const std::exception& e) {
    work->error = e.what();
  } catch (...) {
    work->error = "unknown native error";
  }
}

static void complete_call(napi_env env, napi_status status, void* data) {
  CallWork* work = static_cast<CallWork*>(data);
  if (work->work) g_napi.delete_async_work(env, work->work);

  auto reject = [&](const std::string& message) {
    napi_value message_value = nullptr;
    g_napi.create_string_utf8(env, message.c_str(), message.size(), &message_value);
    napi_value error_value = nullptr;
    g_napi.create_error(env, nullptr, message_value, &error_value);
    g_napi.reject_deferred(env, work->deferred, error_value);
  };

  if (status != napi_ok) {
    reject(work->method + " failed: async work cancelled");
    delete work;
    return;
  }
  if (!work->error.empty()) {
    reject(work->method + " failed: " + work->error);
    delete work;
    return;
  }

  const bool ok = work->result["ok"].type == Json::BOOL && work->result["ok"].boolean;
  if (!ok) {
    const std::string error = work->result["error"].as_string();
    reject(work->method + " failed: " + (error.empty() ? "unknown native error" : error));
    delete work;
    return;
  }

  napi_value result = napi_from_json(env, work->result);
  if (!result) {
    reject(work->method + " failed: could not convert the reply to JavaScript");
    delete work;
    return;
  }
  g_napi.resolve_deferred(env, work->deferred, result);
  delete work;
}

// call(method: string, params: object): Promise<{ok, result, error}>
static napi_value call_binding(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  if (g_napi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    g_napi.throw_error(env, nullptr, "torrent addon: could not read call arguments");
    return nullptr;
  }

  napi_value promise = nullptr;
  napi_deferred deferred = nullptr;
  if (g_napi.create_promise(env, &deferred, &promise) != napi_ok) {
    g_napi.throw_error(env, nullptr, "torrent addon: could not create a promise");
    return nullptr;
  }

  CallWork* work = new CallWork();
  work->deferred = deferred;

  if (argc >= 1) {
    size_t length = 0;
    if (g_napi.get_value_string_utf8(env, argv[0], nullptr, 0, &length) == napi_ok) {
      work->method.resize(length + 1, '\0');
      size_t copied = 0;
      if (g_napi.get_value_string_utf8(env, argv[0], &work->method[0], length + 1, &copied) == napi_ok) {
        work->method.resize(copied);
      } else {
        work->method.clear();
      }
    }
  }
  if (argc >= 2) work->params = json_from_napi(env, argv[1]);
  if (work->params.type != Json::OBJ) work->params = Json::obj();

  napi_value resource_name = nullptr;
  g_napi.create_string_utf8(env, "torrent-call", NAPI_AUTO_LENGTH, &resource_name);
  if (g_napi.create_async_work(env, nullptr, resource_name, execute_call, complete_call, work, &work->work) !=
      napi_ok) {
    delete work;
    napi_value message_value = nullptr;
    g_napi.create_string_utf8(env, "torrent addon: could not queue async work", NAPI_AUTO_LENGTH,
                              &message_value);
    napi_value error_value = nullptr;
    g_napi.create_error(env, nullptr, message_value, &error_value);
    g_napi.reject_deferred(env, deferred, error_value);
    return promise;
  }
  g_napi.queue_async_work(env, work->work);
  return promise;
}

extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (!load_napi_api()) {
    if (g_napi.throw_error) {
      g_napi.throw_error(env, nullptr,
                         "torrent addon: could not resolve the napi_* exports from the host process");
    }
    return nullptr;
  }

  napi_value call_fn = nullptr;
  if (g_napi.create_function(env, "call", NAPI_AUTO_LENGTH, call_binding, nullptr, &call_fn) != napi_ok) {
    g_napi.throw_error(env, nullptr, "torrent addon: could not export call()");
    return nullptr;
  }
  g_napi.set_named_property(env, exports, "call", call_fn);

  napi_value version_value = nullptr;
  g_napi.create_string_utf8(env, lt::version(), NAPI_AUTO_LENGTH, &version_value);
  g_napi.set_named_property(env, exports, "version", version_value);
  return exports;
}

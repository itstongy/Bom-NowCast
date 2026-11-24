--!nonstrict

-- BOM Nowcast bar widget for Noctalia Shell.
-- Polls `bom-nowcast prefetch --noctalia` every 5 minutes to:
--   1) show live rain ETA / status in the bar + 60m sparkline on hover
--   2) keep the radar loop GIF warm so Super+Shift+R launches in ~110ms
--   3) send a native Noctalia notification when rain approaches within 30 min

local POLL_INTERVAL_MS = 300000
local PREFETCH_CMD = "/home/tongy/.local/bin/bom-nowcast prefetch --noctalia"
local REFRESH_CMD = "/home/tongy/.local/bin/bom-nowcast prefetch --noctalia --fresh"
local OPEN_RADAR_CMD = "/home/tongy/.local/bin/hypr-open-or-focus org.tongy.bom-nowcast -- env GDK_WAYLAND_DISABLE=ext_background_effect_manager_v1 ghostty --class=org.tongy.bom-nowcast -e /home/tongy/.local/bin/bom-nowcast"

local inFlight = false
local initialized = false

local function applyPayload(raw)
  local data, err = noctalia.json.decode(raw)
  if type(data) ~= "table" then
    barWidget.setGlyph("cloud-off")
    barWidget.setText("")
    barWidget.setTooltip("BOM Nowcast: invalid output" .. (err and (" (" .. tostring(err) .. ")") or ""))
    return
  end

  barWidget.setGlyph(data.glyph or "cloud")
  barWidget.setText(data.text or "")
  barWidget.setTooltip(data.tooltip or "BOM Nowcast")

  if data.shouldNotify and data.notifyTitle then
    noctalia.notify(tostring(data.notifyTitle), tostring(data.notifyBody or ""))
  end
end

local function poll(cmd)
  if inFlight then
    return
  end
  inFlight = true

  noctalia.runAsync(cmd, function(result)
    inFlight = false
    if not result or result.exitCode ~= 0 then
      barWidget.setGlyph("cloud-off")
      barWidget.setText("")
      barWidget.setTooltip("BOM Nowcast: check failed\nLeft-click to open radar")
      return
    end
    local out = noctalia.string.trim(result.stdout or "")
    if out ~= "" then
      applyPayload(out)
    end
  end)
end

function update()
  if not initialized then
    initialized = true
    noctalia.setUpdateInterval(POLL_INTERVAL_MS)
    barWidget.setGlyph("cloud")
    barWidget.setText("")
    barWidget.setTooltip("BOM Nowcast: loading...")
  end
  poll(PREFETCH_CMD)
end

function onClick(button)
  if button == "right" then
    barWidget.setTooltip("BOM Nowcast: refreshing...")
    poll(REFRESH_CMD)
    return
  end
  noctalia.runAsync(OPEN_RADAR_CMD)
end

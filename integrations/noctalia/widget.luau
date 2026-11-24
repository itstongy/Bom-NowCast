--!nonstrict

-- BOM Nowcast bar widget for Noctalia Shell.
-- Compact stacked layout inside the frosted bar pill:
--   - Dry skies: quiet icon only (sun / cloud).
--   - Rain approaching or overhead: weather icon with tiny intensity label underneath,
--     plus short ETA over a 35px micro bar chart of the next 60 minutes.

local POLL_INTERVAL_MS = 300000
local PREFETCH_CMD = "$HOME/.local/bin/bom-nowcast prefetch --noctalia"
local REFRESH_CMD = "$HOME/.local/bin/bom-nowcast prefetch --noctalia --fresh"
local OPEN_RADAR_CMD = "$HOME/.local/bin/hypr-open-or-focus org.tongy.bom-nowcast -- env GDK_WAYLAND_DISABLE=ext_background_effect_manager_v1 ghostty --class=org.tongy.bom-nowcast -e $HOME/.local/bin/bom-nowcast"

local inFlight = false
local initialized = false

local function bandColor(band)
  if band < 0 then
    return "#d3c6aa38"
  elseif band <= 3 then
    return "#7fbbb3"
  elseif band <= 6 then
    return "#a7c080"
  elseif band <= 10 then
    return "#dbbc7f"
  else
    return "#e67e80"
  end
end

local function bandHeight(band)
  if band < 0 then
    return 2
  end
  local h = math.floor(3 + (band / 14) * 6 + 0.5)
  if h < 3 then h = 3 end
  if h > 9 then h = 9 end
  return h
end

local function hasRainInTimeline(timeline)
  if type(timeline) ~= "table" then
    return false
  end
  for i = 1, #timeline do
    if type(timeline[i]) == "number" and timeline[i] >= 0 then
      return true
    end
  end
  return false
end

local function buildMicroBars(timeline)
  local bars = {}
  for i = 1, #timeline do
    local band = tonumber(timeline[i]) or -1
    table.insert(bars, ui.box({
      width = 2,
      height = bandHeight(band),
      radius = 1,
      fill = bandColor(band),
    }))
  end
  return ui.row({ gap = 1, align = "end", height = 9 }, bars)
end

local function renderIdle(glyph, color, tooltip)
  barWidget.render(
    ui.row({ gap = 0, align = "center" }, {
      ui.glyph({ name = glyph or "cloud", size = 16, color = color or "secondary" }),
    })
  )
  barWidget.setTooltip(tooltip or "BOM Nowcast")
end

local function applyPayload(raw)
  local data, err = noctalia.json.decode(raw)
  if type(data) ~= "table" then
    renderIdle("cloud-off", "secondary", "BOM Nowcast: invalid output" .. (err and (" (" .. tostring(err) .. ")") or ""))
    return
  end

  local glyph = data.glyph or "cloud"
  local color = data.color or "secondary"
  local title = data.title or ""
  local subtitle = data.subtitle or ""
  local timeline = data.timeline60m
  local showGraph = hasRainInTimeline(timeline)

  if title == "" and not showGraph then
    renderIdle(glyph, color, data.tooltip or "BOM Nowcast")
  else
    -- Left stack: weather icon with tiny intensity label directly underneath.
    local leftChildren = {
      ui.glyph({ name = glyph, size = 14, color = color }),
    }
    if subtitle ~= "" then
      table.insert(leftChildren, ui.label({
        text = subtitle,
        fontSize = 8,
        color = color,
        opacity = 0.85,
      }))
    end

    local rowChildren = {
      ui.column({ gap = 0, align = "center" }, leftChildren),
    }

    -- Right stack: compact ETA on top, tiny 35px micro bar chart underneath.
    local rightChildren = {}
    if title ~= "" then
      table.insert(rightChildren, ui.label({
        text = title,
        fontSize = 11,
        fontWeight = "semibold",
        color = color,
      }))
    end
    if showGraph then
      table.insert(rightChildren, buildMicroBars(timeline))
    end
    if #rightChildren > 0 then
      table.insert(rowChildren, ui.column({ gap = 2, align = "start" }, rightChildren))
    end

    barWidget.render(ui.row({ gap = 5, align = "center" }, rowChildren))
    barWidget.setTooltip(data.tooltip or "BOM Nowcast")
  end

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
      renderIdle("cloud-off", "secondary", "BOM Nowcast: check failed\nLeft-click to open radar")
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
    renderIdle("cloud", "secondary", "BOM Nowcast: loading...")
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

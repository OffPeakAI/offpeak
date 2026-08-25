-- Atomic prepaid holds for one buyer. Amounts are integer strings that fit signed 64-bit.
-- KEYS[1] prefix; ARGV[1] action.
--
-- admit:   amount, hour, day, hourlyCap, dailyCap, balance, servableFlag, holdId, expiresAt, now, lastSettledHour, fromHold
--          fromHold is optional: a larger hold this one is carved out of, as a night job's line is from its hour's hold.
-- capture: holdId, actual, hour. Safe to repeat, and still counts spend if the hold has expired.
-- release: holdId
-- committed: lastSettledHour. Unsettled spend plus open holds, for planning against the balance.
--
-- <prefix>:holds  holdId -> "amount:hour:day"
-- <prefix>:expiry holdId scored by expiry, so a router that dies mid-request leaves nothing behind
-- <prefix>:open   running open amounts: "total", "h<hour>", "d<day>"
-- <prefix>:spend  hour -> captured spend, kept while it counts toward a cap or is unsettled

local prefix = KEYS[1]
local action = ARGV[1]
local holds = prefix .. ":holds"
local expiry = prefix .. ":expiry"
local open = prefix .. ":open"
local spend = prefix .. ":spend"

local function lower(field, amount)
  if redis.call("HINCRBY", open, field, -amount) <= 0 then
    redis.call("HDEL", open, field)
  end
end

-- Removes a hold and frees its amount. Returns its hour, or nil if it is gone.
local function drop(id)
  local raw = redis.call("HGET", holds, id)
  if not raw then
    return nil
  end
  local amount, hour, day = string.match(raw, "^(%d+):(%d+):(%d+)$")
  amount = tonumber(amount)
  redis.call("HDEL", holds, id)
  redis.call("ZREM", expiry, id)
  lower("total", amount)
  lower("h" .. hour, amount)
  lower("d" .. day, amount)
  return hour
end

if action == "capture" then
  local done = prefix .. ":done:" .. ARGV[2]
  if redis.call("EXISTS", done) == 1 then
    return "ok"
  end
  drop(ARGV[2])
  redis.call("HINCRBY", spend, ARGV[4], ARGV[3])
  redis.call("SET", done, "1", "EX", 172800)
  return "ok"
end

if action == "release" then
  drop(ARGV[2])
  return "ok"
end

if action == "committed" then
  local total = tonumber(redis.call("HGET", open, "total") or "0")
  local rows = redis.call("HGETALL", spend)
  for i = 1, #rows, 2 do
    if tonumber(rows[i]) > tonumber(ARGV[2]) then total = total + tonumber(rows[i + 1]) end
  end
  return tostring(total)
end

local amount = tonumber(ARGV[2])
local hour = ARGV[3]
local day = ARGV[4]
local hourlyCap = tonumber(ARGV[5])
local dailyCap = tonumber(ARGV[6])
local balance = tonumber(ARGV[7])
local servable = ARGV[8]
local holdId = ARGV[9]
local expiresAt = ARGV[10]
local now = ARGV[11]
local lastSettled = tonumber(ARGV[12])

if servable ~= "1" then
  return servable
end

for _, id in ipairs(redis.call("ZRANGEBYSCORE", expiry, "-inf", now)) do
  drop(id)
end

local hourOpen = tonumber(redis.call("HGET", open, "h" .. hour) or "0")
local dayOpen = tonumber(redis.call("HGET", open, "d" .. day) or "0")
local totalOpen = tonumber(redis.call("HGET", open, "total") or "0")

-- What the larger hold gives up counts as free here, and leaves it only if this admit passes.
local parent, parentAmount, parentHour, parentDay, carved = ARGV[13], 0, nil, nil, 0
if parent and parent ~= "" then
  local raw = redis.call("HGET", holds, parent)
  if raw then
    parentAmount, parentHour, parentDay = string.match(raw, "^(%d+):(%d+):(%d+)$")
    parentAmount = tonumber(parentAmount)
    carved = math.min(parentAmount, amount)
    totalOpen = totalOpen - carved
    if parentHour == hour then hourOpen = hourOpen - carved end
    if parentDay == day then dayOpen = dayOpen - carved end
  end
end

local hourSpend, daySpend, unsettled = 0, 0, 0
local thisDay = tonumber(day)
local rows = redis.call("HGETALL", spend)
for i = 1, #rows, 2 do
  local spentHour = tonumber(rows[i])
  local spent = tonumber(rows[i + 1])
  local spentDay = math.floor(spentHour / 24)
  if rows[i] == hour then hourSpend = spent end
  if spentDay == thisDay then daySpend = daySpend + spent end
  if spentHour > lastSettled then
    unsettled = unsettled + spent
  elseif spentDay < thisDay then
    redis.call("HDEL", spend, rows[i])
  end
end

if hourSpend + hourOpen + amount > hourlyCap then
  return "insufficient_reserve"
end
if daySpend + dayOpen + amount > dailyCap then
  return "insufficient_reserve"
end
if unsettled + totalOpen + amount > balance then
  return "insufficient_reserve"
end

if carved > 0 then
  lower("total", carved)
  lower("h" .. parentHour, carved)
  lower("d" .. parentDay, carved)
  if parentAmount == carved then
    redis.call("HDEL", holds, parent)
    redis.call("ZREM", expiry, parent)
  else
    redis.call("HSET", holds, parent, string.format("%.0f:%s:%s", parentAmount - carved, parentHour, parentDay))
  end
end

redis.call("HSET", holds, holdId, ARGV[2] .. ":" .. hour .. ":" .. day)
redis.call("ZADD", expiry, expiresAt, holdId)
redis.call("HINCRBY", open, "total", amount)
redis.call("HINCRBY", open, "h" .. hour, amount)
redis.call("HINCRBY", open, "d" .. day, amount)
return "ok"

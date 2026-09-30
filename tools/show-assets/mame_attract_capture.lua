-- Generic MAME 0.289 capture: 20-frame interval, 240 emulated seconds.
-- Field names matched: "Coin 1", "1 Player Start", "P1 Button 1".
-- Each found tag/name is printed to the private per-game log. Digital
-- field:set_value(1) asserts the input regardless of its active-low mask.
-- Configure all writable MAME directories on the command line.
local n, subscription = 0, nil
local coin, start, confirm
local function find_field(name)
  for tag, port in pairs(manager.machine.ioport.ports) do
    for key, field in pairs(port.fields) do
      if key == name then
        print("CAPTURE_INPUT " .. tag .. " / " .. key)
        return field
      end
    end
  end
  print("CAPTURE_MISSING_INPUT " .. name)
end
coin = find_field("Coin 1")
start = find_field("1 Player Start")
confirm = find_field("P1 Button 1")
local function pulse(field, on)
  if field then
    if on then field:set_value(1) else field:clear_value() end
  end
end
local function frame()
  n = n + 1
  if n == 3600 then pulse(coin, true) end
  if n == 3606 then pulse(coin, false) end
  if n == 3660 then pulse(start, true) end
  if n == 3666 then pulse(start, false) end
  -- A confirmation pulse advances character selection after coin/start.
  if n == 3780 then pulse(confirm, true) end
  if n == 3786 then pulse(confirm, false) end
  if n % 20 == 0 then manager.machine.video:snapshot() end
  if n >= 14400 then
    print("CAPTURE_COMPLETE frames=" .. n)
    manager.machine:exit()
  end
end
if emu.add_machine_frame_notifier then
  subscription = emu.add_machine_frame_notifier(frame)
else
  emu.register_frame_done(frame, "capture")
end

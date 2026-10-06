# wakeup-ali-pc: MikroTik poller (RouterOS 7.x)
#
# Every minute the router:
#   1. checks whether the PC is up (ping, falling back to ARP state),
#   2. calls  GET <URL>?pc=up|down  with  "Authorization: Bearer <ROUTER_TOKEN>",
#   3. sends 3 Wake-on-LAN magic packets if the server answers "wake".
#
# Before importing, replace the four values in the "config" block below.
# Install:   /import file-name=wakeup.rsc
# Uninstall: /system scheduler remove [find name=wakeup-poll]; /system script remove [find name=wakeup-poll]

/system script remove [find name=wakeup-poll]
/system scheduler remove [find name=wakeup-poll]

/system script add name=wakeup-poll dont-require-permissions=no policy=read,write,test source={
  # ---- config ----
  :local url "https://wake.example.com/api/router/poll"
  :local token "REPLACE_WITH_ROUTER_TOKEN"
  :local pcMac "AA:BB:CC:DD:EE:FF"
  :local iface "bridge"
  # ----------------

  :local pc "down"
  :local arpIds [/ip arp find where mac-address=$pcMac]
  :if ([:len $arpIds] > 0) do={
    :local pcIp [/ip arp get ($arpIds->0) address]
    :if ([/ping $pcIp count=2 interval=300ms] > 0) do={
      :set pc "up"
    } else={
      # Windows may block ping; a fresh ARP reply still proves the NIC is awake
      :if ([/ip arp get ($arpIds->0) status] = "reachable") do={ :set pc "up" }
    }
  }

  :local answer ""
  :do {
    :local r [/tool fetch url=($url . "?pc=" . $pc) http-header-field=("Authorization: Bearer " . $token) check-certificate=yes output=user as-value]
    :set answer ($r->"data")
  } on-error={
    :log warning "wakeup-poll: could not reach server"
  }

  :if ($answer = "wake") do={
    :for i from=1 to=3 do={
      /tool wol mac=$pcMac interface=$iface
      :delay 2s
    }
    :log info "wakeup-poll: magic packets sent"
  }
}

/system scheduler add name=wakeup-poll interval=1m start-time=startup policy=read,write,test on-event="/system script run wakeup-poll"

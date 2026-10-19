/*
  (C) 2007-09 - Luca Deri <deri@ntop.org>
*/

#include "../n2n.h"
#include "n2n_win32.h"

/* 1500 bytes payload + 14 bytes ethernet header + 4 bytes VLAN tag */
#define MTU 1518

void initWin32() {
  WSADATA wsaData;
  int err;

  err = WSAStartup(MAKEWORD(2, 2), &wsaData );
  if( err != 0 ) {
    /* Tell the user that we could not find a usable */
    /* WinSock DLL.                                  */
    printf("��������: �޷���ʼ�� Winsock 2.x.");
    exit(-1);
  }
}

int open_wintap(struct tuntap_dev *device,
                const char * address_mode, /* "static" or "dhcp" */
                char *device_ip, 
                char *device_mask,
                const char *device_mac, 
                int mtu) {
  HKEY key, key2;
  LONG rc;
  char regpath[1024], cmd[256];
  char adapterid[1024];
  char adaptername[1024];
  char tapname[1024];
  long len;
  int found = 0;
  int err, i;
  ULONG status = TRUE;

  memset(device, 0, sizeof(struct tuntap_dev));
  device->device_handle = INVALID_HANDLE_VALUE;
  device->device_name = NULL;
  device->ifName = NULL;
  device->ip_addr = inet_addr(device_ip);

  /* Open registry and look for network adapters */
  if((rc = RegOpenKeyEx(HKEY_LOCAL_MACHINE, NETWORK_CONNECTIONS_KEY, 0, KEY_READ, &key))) {
    printf("�޷���ȡע���? [rc=%d]\n", rc);
    exit(-1);
    /* MSVC Note: If you keep getting rc=2 errors, make sure you set:
       Project -> Properties -> Configuration Properties -> General -> Character set
       to: "Use Multi-Byte Character Set"
    */
  }

  for (i = 0; ; i++) {
    len = sizeof(adapterid);
    if(RegEnumKeyEx(key, i, (LPTSTR)adapterid, &len, 0, 0, 0, NULL))
      break;

    /* Find out more about this adapter */

    _snprintf(regpath, sizeof(regpath), "%s\\%s\\Connection", NETWORK_CONNECTIONS_KEY, adapterid);
    if(RegOpenKeyEx(HKEY_LOCAL_MACHINE, (LPCSTR)regpath, 0, KEY_READ, &key2))
      continue;

    len = sizeof(adaptername);
    err = RegQueryValueEx(key2, "Name", 0, 0, adaptername, &len);

    RegCloseKey(key2);

    if(err)
      continue;

    if(device->device_name) {
      if(!strcmp(device->device_name, adapterid)) {
	found = 1;
	break;
      } else
	continue;
    }

    if(device->ifName) {
      if(!strcmp(device->ifName, adaptername)) {
	found = 1;
	break;
      } else
	continue;
    }

    _snprintf(tapname, sizeof(tapname), USERMODEDEVICEDIR "%s" TAPSUFFIX, adapterid);
    device->device_handle = CreateFile(tapname, GENERIC_WRITE | GENERIC_READ,
				       0, /* Don't let other processes share or open
					     the resource until the handle's been closed */
				       0, OPEN_EXISTING, FILE_ATTRIBUTE_SYSTEM | FILE_FLAG_OVERLAPPED, 0);
    if(device->device_handle != INVALID_HANDLE_VALUE) {
      found = 1;
      break;
    }
  }

  RegCloseKey(key);

  if(!found) {
    printf("�Ҳ��� Windows tap �豸!\n");
    exit(0);
  }

  /* ************************************** */

  if(!device->device_name)
    device->device_name = _strdup(adapterid);

  if(!device->ifName)
    device->ifName = _strdup(adaptername);

  /* Try to open the corresponding tap device->device_name */

  if(device->device_handle == INVALID_HANDLE_VALUE) {
    _snprintf(tapname, sizeof(tapname), USERMODEDEVICEDIR "%s" TAPSUFFIX, device->device_name);
    device->device_handle = CreateFile(tapname, GENERIC_WRITE | GENERIC_READ, 0, 0, 
									   OPEN_EXISTING, FILE_ATTRIBUTE_SYSTEM | FILE_FLAG_OVERLAPPED, 0);
  }

  if(device->device_handle == INVALID_HANDLE_VALUE) {
    printf("%s (%s) ���ǿ��õ� Windows tap �豸\n", device->device_name, device->ifName);
    exit(-1);
  }

    /* Get MAC address from tap device->device_name */

  if(!DeviceIoControl(device->device_handle, TAP_IOCTL_GET_MAC,
                      device->mac_addr, sizeof(device->mac_addr),
                      device->mac_addr, sizeof(device->mac_addr), &len, 0)) {
    printf("�޷���Windows Tap�ӿ� %s (%s) ��ȡMAC��ַ\n",
           device->device_name, device->ifName);
    return -1;
  }

   device->mtu = mtu;
   /*************************20241130���ε�������δ���?************
   printf("���豸 [����=%s][ip=%s][�ӿ�=%s][MTU=%d][mac=%02X:%02X:%02X:%02X:%02X:%02X]\n",
	 device->device_name, device_ip, device->ifName, device->mtu,
	 device->mac_addr[0] & 0xFF,
	 device->mac_addr[1] & 0xFF,
	 device->mac_addr[2] & 0xFF,
	 device->mac_addr[3] & 0xFF,
	 device->mac_addr[4] & 0xFF,
	 device->mac_addr[5] & 0xFF);*/

  /* ****************** */

  //printf("�������� %s ������ַ...\n", device->ifName);

  if ( 0 == strcmp("dhcp", address_mode) )
  {
      _snprintf(cmd, sizeof(cmd),
                "netsh interface ip set address \"%s\" dhcp",
                device->ifName);
  }
  else
  {
      _snprintf(cmd, sizeof(cmd),
                "netsh interface ip set address \"%s\" static %s %s",
                device->ifName, device_ip, device_mask);
  }

  if(system(cmd) == 0) {
    device->ip_addr = inet_addr(device_ip);
    device->device_mask = inet_addr(device_mask);
    traceEvent(TRACE_NORMAL, "���ؾ�������ַ���óɹ� %s/%s", device_ip, device_mask);
    //printf("���ؾ�������ַ���óɹ�: %s/%s\n",//���� %s ��ַ��: %s/%s
	   /*device->ifName, *///device_ip, device_mask);
  } else
    printf("��ʾ: �޷����� %s ��IP��ַ,����[%s]\n",
			device->ifName, cmd);

  /* ****************** */

  if(device->mtu != DEFAULT_MTU)
	printf("���棺�� Windows �ϲ�֧������ MTU\n");

  /* set driver media status to 'connected' (i.e. set the interface up) */
  /* handle is opened FILE_FLAG_OVERLAPPED: passing lpOverlapped=NULL here makes the
     ioctl fail on modern Windows and the adapter stays "cable pulled" (IP traffic
     dead, cross-node probes unreachable) -- use a temp event + wait completion */
  {
    OVERLAPPED ov;
    DWORD le = 0;
    ZeroMemory(&ov, sizeof(ov));
    ov.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
    if (ov.hEvent != NULL) {
      if (!DeviceIoControl (device->device_handle, TAP_IOCTL_SET_MEDIA_STATUS,
                            &status, sizeof (status),
                            &status, sizeof (status), &len, &ov)) {
        le = GetLastError();
        if (le != ERROR_IO_PENDING)
          printf("warning: TAP_IOCTL_SET_MEDIA_STATUS failed le=%lu\n", (unsigned long)le);
      }
      if (le == ERROR_IO_PENDING)
        GetOverlappedResult(device->device_handle, &ov, &len, TRUE);
      CloseHandle(ov.hEvent);
    }
  }

  /*
   * Initialize overlapped structures
   */
  device->overlap_read.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
  device->overlap_write.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
  if (!device->overlap_read.hEvent || !device->overlap_write.hEvent) {
    return -1;
  }

  return(0);
}

/* ************************************************ */

int tuntap_read(struct tuntap_dev *tuntap, unsigned char *buf, int len)
{
  DWORD read_size, last_err;

  ResetEvent(tuntap->overlap_read.hEvent);
  if (ReadFile(tuntap->device_handle, buf, len, &read_size, &tuntap->overlap_read)) {
    //printf("tun_read(len=%d)\n", read_size);
    return read_size;
  }
  switch (last_err = GetLastError()) {
  case ERROR_IO_PENDING:
    WaitForSingleObject(tuntap->overlap_read.hEvent, INFINITE);
    GetOverlappedResult(tuntap->device_handle, &tuntap->overlap_read, &read_size, FALSE);
    return read_size;
    break;
  default:
    printf("GetLastError() ������ %d\n", last_err);
    break;
  }

  return -1;
}
/* ************************************************ */

int tuntap_write(struct tuntap_dev *tuntap, unsigned char *buf, int len)
{
  DWORD write_size;

  //printf("tun_write(len=%d)\n", len);

  ResetEvent(tuntap->overlap_write.hEvent);
  if (WriteFile(tuntap->device_handle,
		buf,
		len,
		&write_size,
		&tuntap->overlap_write)) {
    //printf("DONE tun_write(len=%d)\n", write_size);
    return write_size;
  }
  switch (GetLastError()) {
  case ERROR_IO_PENDING:
    WaitForSingleObject(tuntap->overlap_write.hEvent, INFINITE);
    GetOverlappedResult(tuntap->device_handle, &tuntap->overlap_write,
			&write_size, FALSE);
    return write_size;
    break;
  default:
    break;
  }

  return -1;
}

/* ************************************************ */

int tuntap_open(struct tuntap_dev *device, 
                char *dev, 
                const char *address_mode, /* static or dhcp */
                char *device_ip, 
                char *device_mask, 
                const char * device_mac, 
                int mtu) {
    return(open_wintap(device, address_mode, device_ip, device_mask, device_mac, mtu));
}

/* ************************************************ */

void tuntap_close(struct tuntap_dev *tuntap) {
  CloseHandle(tuntap->device_handle);
}

/* Fill out the ip_addr value from the interface. Called to pick up dynamic
 * address changes. */
void tuntap_get_address(struct tuntap_dev *tuntap)
{
}

/* ************************************************ */

#if 0
int main(int argc, char* argv[]) {
  struct tuntap_dev tuntap;
  int i;
  int mtu = 1400;

  printf("��ӭʹ�ø��ؾ�����:��ŵ����QQ4722100\n");
  initWin32();
  open_wintap(&tuntap, "static", "1.2.3.20", "255.255.255.0", mtu);

  for(i=0; i<10; i++) {
    u_char buf[MTU];
    int rc;

    rc = tun_read(&tuntap, buf, sizeof(buf));
    buf[0]=2;
    buf[1]=3;
    buf[2]=4;

    printf("tun_read ������ %d\n", rc);
    rc = tun_write(&tuntap, buf, rc);
    printf("tun_write ������ %d\n", rc);
  }
  // rc = tun_open (device->device_name, IF_MODE_TUN);
  WSACleanup ();
  return(0);
}

#endif

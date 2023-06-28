## Monitor your servers at a sight!

This simple server shows your servers' GPU information on a single HTML page.

If you or your jobplace have several servers utilizing multiple GPUs,

this will help you monitor them at once without typing commands at every console of the servers.


### Pros

* Based on SSH connection, so you don't have to install anything on your server. (except NVIDIA driver and CUDA)
* Badass looking HTML pages. It will motivate your will of experiments.
* Conveying various information including memory and power consumption.
* Easy to use.

### Cons

* Messed up frontend codes because I've never experienced forntend practically. It works perfectly, but future modifications would be bothersome.
* Only supports NVIDIA GPUs.
* Not useful for massive amounts of servers. Imagine thousands of servers appearing only on a single page.
* These codes are built in haste just for my own usage, thus have some restrictions such that SSH accounts must have same passwords (which is not secure at all), etc.

If I ever feel to enhance this project, I will absolutely fix those cons and expand this project further.

## Quickstart

1. Install prerequisites on your monitoring server (meaning not one of GPU servers). This server requires following packages.

   - NodeJS
   - npm
   - node-ssh (npm module)
  
2. Clone this project into your monitoring server.

```bash
git clone https://github.com/GimmeSpoon/DL-Monitoring
```

3. Make a `servers.json` file including information of your GPU servers like below. Make sure those accounts have the same password.

```json
{
  "servers":[ 
    { "name" : "myserver",
      "addr" : "123.0.0.2",
      "port" : 22,
      "username" : "gusfring" },
    { "name" : "anotehrserver",
      "addr" : "123.0.0.3",
      "port" : 22,
      "username" : "kidnamedfinger" }
  ]
}
```

4. Start it! But you have to write your passwords of account you just included in json. Then encrypted password will be saved into passwd.txt. I know this is not secure, I just needed this server in a hurry and only for my personal usage at first.

```bash
node mllab_monitor_vx.x.x.js -- (MASTER_KEY) (PASSWORD)
```

Next time you ever need to restart it, you can just type master key, if passwd.txt exists.

```bash
node mllab_monitor_vx.x.x.js -- (MASTER_KEY)
```

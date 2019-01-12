# Go extension

This extension provides Go code intelligence on Sourcegraph.

![image](https://user-images.githubusercontent.com/1387653/49856504-ce281f80-fda4-11e8-933b-f8fc67c98daf.png)

## How to deploy the server

The extension is configured to talk to a language server deployed somewhere over WebSockets.
The server is available as a Docker image `sourcegraph/lang-go` from Docker Hub.

### Using Docker

1. Run the Go language server:

    ```sh
    docker run --rm --name lang-go -p 4389:4389 sourcegraph/lang-go \
      go-langserver -mode=websocket -addr=:4389 -usebuildserver -usebinarypkgcache=false
    ```

    You can verify it's up and running with [`ws`](https://github.com/hashrocket/ws):

    ```sh
    $ go get -u github.com/hashrocket/ws
    $ ws ws://localhost:4389
    >
    ```

1. Enable this extension on your Sourcegraph  https://sourcegraph.example.com/extensions/sourcegraph/lang-go

1. Add these to your Sourcegraph settings in https://sourcegraph.example.com/site-admin/global-settings and make sure the port matches either the Docker command or your Kubernetes config:

    ```sh
    "go.serverUrl": "ws://localhost:4389",
    "go.sourcegraphUrl": "http://host.docker.internal:7080",
    ```

    If you're running on Linux, change `go.sourcegraphUrl` to the IP given by:

    ```bash
    ip addr show docker0 | grep -Po 'inet \K[\d.]+'
    ```

Now visit a Go file and you should see code intelligence!

### Authentication proxies and firewalls

Some customers deploy Sourcegraph behind an authentication proxy or firewall. If you do this, we
recommend deploying the language server behind the proxy so that it can issue requests directly to
Sourcegraph without going through the proxy. (Otherwise, you will need to configure the language
server to authenticate through your proxy.) Make sure you set `go.sourcegraphUrl` to the URL
that the language server should use to reach Sourcegraph, which is likely different from the URL
that end users use.

## Using Kubernetes

Here's a sample Kuberentes configuration:

```yaml
apiVersion: v1
kind: Service
metadata:
  annotations:
    prometheus.io/port: "6060"
    prometheus.io/scrape: "true"
  labels:
    app: lang-go
  name: lang-go
  namespace: prod
spec:
  loadBalancerIP: your.static.ip.address
  ports:
  - name: debug
    port: 6060
    targetPort: debug
  - name: lsp
    port: 443
    targetPort: lsp
  selector:
    app: lang-go
  type: LoadBalancer
```

```yaml
apiVersion: extensions/v1beta1
kind: Deployment
metadata:
  annotations:
    description: Go code intelligence provided by go-langserver
  name: lang-go
  namespace: prod
spec:
  minReadySeconds: 10
  replicas: 1
  revisionHistoryLimit: 10
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: lang-go
    spec:
      containers:
      - args:
        - go-langserver
        - -mode=websocket
        - -addr=:4389
        - -usebuildserver
        - -usebinarypkgcache=false
        - -cachedir=$(CACHE_DIR)
        env:
        - name: LIGHTSTEP_ACCESS_TOKEN
          value: '???'
        - name: LIGHTSTEP_INCLUDE_SENSITIVE
          value: "true"
        - name: LIGHTSTEP_PROJECT
          value: sourcegraph-prod
        # TLS is optional
        - name: TLS_CERT
          valueFrom:
            secretKeyRef:
              key: cert
              name: tls
        - name: TLS_KEY
          valueFrom:
            secretKeyRef:
              key: key
              name: tls
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: CACHE_DIR
          value: /mnt/cache/$(POD_NAME)
        image: sourcegraph/lang-go:latest
        livenessProbe:
          initialDelaySeconds: 5
          tcpSocket:
            port: lsp
          timeoutSeconds: 5
        name: lang-go
        ports:
        - containerPort: 4389
          name: lsp
        - containerPort: 6060
          name: debug
        readinessProbe:
          tcpSocket:
            port: 4389
        resources:
          limits:
            cpu: "8"
            memory: 10G
          requests:
            cpu: "1"
            memory: 10G
        volumeMounts:
        - mountPath: /mnt/cache
          name: cache-ssd
      volumes:
      - hostPath:
          path: /mnt/disks/ssd0/pod-tmp
        name: cache-ssd
```

## Private dependencies

### Private dependencies via `.netrc`

Make sure your `$HOME/.netrc` contains:

```
machine codeload.github.com
login <your username>
password <your password OR access token>
```

Mount it into the container:

```
docker run ... -v "$HOME/.netrc":/root/.netrc ...
```

Verify fetching works:

```
$ docker exec -ti lang-go sh
# curl -n https://codeload.github.com/you/your-private-repo/zip/master
HTTP/1.1 200 OK
...
```

### Private dependencies via SSH keys

Make sure your `~/.gitconfig` contains these lines:

```
[url "git@github.com:"]
    insteadOf = https://github.com/
```

Mount that and your SSH keys into the container:

```
docker run ... -v "$HOME/.gitconfig":/root/.gitconfig -v "$HOME/.ssh":/root/.ssh ...
```

Verify cloning works:

```
$ docker exec -ti lang-go sh
# git clone https://github.com/you/your-private-repo
Cloning into 'your-private-repo'...
```

## Scaling out by increasing the replica count

You can run multiple instances of the go-langserver and distribute connections between them in Kubernetes by setting `spec.replicas` in the deployment YAML:

```diff
 spec:
   minReadySeconds: 10
-  replicas: 1
+  replicas: 5
   revisionHistoryLimit: 10
```

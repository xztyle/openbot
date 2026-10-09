# Private OpenBot release scripts

Build and deployment are separate actions. Deploy only when Alejandro asks.

`build.sh` builds a Linux amd64 image locally, including on an ARM Mac. The dedicated
Docker builder has an 8 GB memory cap and builds one stage at a time. Node's heap
limit is 8192 MB. It reads the existing private website configuration over SSH.
Server passwords and SSH private keys do not enter the image or build context.

```sh
./build.sh ubuntu@144.217.13.252 /absolute/path/to/VPS-admin-key
```

The script fetches `fork/main`, builds its committed revision, and prints the release
directory. Artifacts and private settings stay in the ignored `.openbot-build/releases`
directory. The Docker cache reduces work on later builds. The script records its
own elapsed time.

`deploy.sh` uploads a finished release. It does not install project dependencies or
compile code on the VPS. It loads the amd64 image, tests it against empty data, applies
compatible account-service migrations, uploads the prebuilt Cloudflare Worker, and
restarts the host. Existing Cloudflare credentials stay on the VPS.

```sh
./deploy.sh ubuntu@144.217.13.252 /absolute/path/to/VPS-admin-key /absolute/path/to/release
```

Deployment stops if a bot has active or queued work. It preserves the data volume,
provider credentials, runtime settings, and existing network protections. It checks
the saved-data format, database integrity, row counts, and signed-in host connection.
The release directory on the VPS contains `deployment.json` with phase timings.

Database upgrades cannot be undone by starting an older image. The scripts do not
copy, reset, or automatically back up the user database.

For a slow local connection, run the same build stages on the VPS instead. The
current deployment uses that route; no image upload crosses the user's hotspot.

Verification: shell syntax and Python compilation passed. The prebuilt deployment
helper passed a full VPS deployment and saved-data checks. The complete local Docker build remains
unverified because the user cancelled its initial tool download while on a hotspot.

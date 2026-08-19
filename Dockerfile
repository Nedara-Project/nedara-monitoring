FROM debian:trixie-slim

ENV HOME_DIR=/usr/local/nedara-monitoring
ENV NEDARA_DATA_DIR=/var/lib/nedara-monitoring
ENV VIRTUAL_ENV=/usr/local/nedara-monitoring/.venv
ENV PATH=/usr/local/nedara-monitoring/.venv/bin:$PATH
# Unbuffered: the application logs through print(), and a buffered stdout keeps
# it out of `docker logs` until the buffer fills.
ENV PYTHONUNBUFFERED=1

# The runtime user must own the bind-mounted config.ini for the admin
# interface to be able to write it back: align it with the host user when it is
# not uid 1000 (rootless Docker maps the host owner to uid 0 in the container).
ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR ${HOME_DIR}

# libpq5 is the runtime dependency of psycopg; python3-venv ships its own pip.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-docker.txt ./
RUN python3 -m venv ${VIRTUAL_ENV} \
    && pip install --no-cache-dir -r requirements-docker.txt

COPY . .
COPY docker/start-nedara-monitoring.sh /usr/local/bin/start-nedara-monitoring

# The dashboard loads nedarajs from the build context: fail here rather than
# shipping an image whose front-end silently 404s.
RUN test -f static/js/lib/nedarajs/nedara.js || { \
        echo "ERROR: static/js/lib/nedarajs is empty."; \
        echo "Run: git submodule update --init --recursive"; \
        exit 1; \
    }

# Only the data directory (chart history, mail locks) needs to be writable, so
# the application itself runs unprivileged. The user is only created when the
# requested uid is free: APP_UID=0 reuses root, as rootless Docker needs.
RUN if ! getent passwd ${APP_UID} > /dev/null; then \
        groupadd --force --gid ${APP_GID} nedara \
        && useradd --uid ${APP_UID} --gid ${APP_GID} --no-user-group \
            --home-dir ${HOME_DIR} --shell /usr/sbin/nologin nedara; \
    fi \
    && mkdir -p ${NEDARA_DATA_DIR} \
    && chown ${APP_UID}:${APP_GID} ${NEDARA_DATA_DIR}

USER ${APP_UID}:${APP_GID}
EXPOSE 5000

CMD ["/usr/local/bin/start-nedara-monitoring"]

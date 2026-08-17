FROM debian:latest AS nedara-monitoring

ENV HOME_DIR=/usr/local/nedara-monitoring
WORKDIR ${HOME_DIR}

RUN apt-get update && apt-get -y install python3 python3-venv git pip libpq-dev

RUN cd $(dirname ${HOME_DIR}) && git clone https://github.com/Nedara-Project/nedara-monitoring.git && cd nedara-monitoring && git submodule update --init --recursive

# COPY ./config.ini.example .
COPY ./docker/start-nedara-monitoring.sh /usr/local/bin/start-nedara-monitoring
COPY ./requirements.txt .

RUN python3 -m venv .venv && . ./.venv/bin/activate && pip install gunicorn eventlet && pip install -r requirements.txt

USER root
EXPOSE 5000

CMD ["/usr/local/bin/start-nedara-monitoring"]
# Presidio's analyzer with a Polish NER model next to the English one it ships with.
FROM ghcr.io/data-privacy-stack/presidio-analyzer:2.2.364

USER root
# Must match the image's spaCy (3.8.x).
RUN pip install --no-cache-dir \
    https://github.com/explosion/spacy-models/releases/download/pl_core_news_lg-3.8.0/pl_core_news_lg-3.8.0-py3-none-any.whl

COPY conf/ /app/poc-conf/
ENV NLP_CONF_FILE=poc-conf/nlp.yaml \
    ANALYZER_CONF_FILE=poc-conf/analyzer.yaml \
    RECOGNIZER_REGISTRY_CONF_FILE=poc-conf/recognizers.yaml

USER 1001

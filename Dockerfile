FROM openemr/openemr:latest@sha256:1d8073d3acfc15b53e771f264b84c0be41a0f0c998f413af39811e1c2e5d8061

COPY --chown=apache:apache . /var/www/localhost/htdocs/openemr/

# Regenerate the Composer classmap. The upstream image's classmap was built
# against the upstream library/classes/ tree; after we COPY our fork on top
# any class that lives only in the fork fails to autoload. Symptom:
# patient-summary cards (medications, vitals, insurance, immunizations) blow
# up with "Class \"PrescriptionPatient\" not found" because
# library/classes/Prescription.class.php news up that class.
#
# Use --optimize but NOT --classmap-authoritative: composer.json explicitly
# excludes src/Common/Compatibility/Checker.php from the classmap (it must
# be loaded by interface/globals.php BEFORE the autoloader runs version
# checks), and authoritative mode would disable the PSR-4 fallback that
# normally finds it.
RUN cd /var/www/localhost/htdocs/openemr \
    && composer dump-autoload --optimize \
    # Railway's snapshot upload strips group/other read+exec bits on some
    # files (notably public/assets/agentforge/ — perms come back as 700/600
    # so apache can't traverse the dir or serve agent-sidebar.js). Re-apply
    # sane perms on the directories the web server must serve.
    && chmod -R u=rwX,go=rX public/assets bin/console

# Lazy registration of the patient-dashboard SMART OAuth client. Hooked via
# auto_prepend_file so the first PHP request the apache child handles
# triggers an idempotent upsert against oauth_clients (reading the public
# redirect_uri from OPENEMR_PUBLIC_URL). Steady-state cost is one stat()
# per request; see contrib/util/dashboard-bootstrap.php for the lock /
# retry semantics. Glob covers any /etc/php<ver>/conf.d the upstream
# image happens to ship — version is not pinned so don't hardcode it.
RUN for d in /etc/php*/conf.d; do \
        echo 'auto_prepend_file = /var/www/localhost/htdocs/openemr/contrib/util/dashboard-bootstrap.php' \
            > "$d/99-dashboard-bootstrap.ini"; \
    done

EXPOSE 80
EXPOSE 443

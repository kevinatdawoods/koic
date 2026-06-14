#!/usr/bin/perl
use strict;
use warnings;
use Mojolicious::Lite;
use Mojo::IOLoop;
use Mojo::UserAgent;
use Mojo::URL;
use IO::Socket::INET;
use Scalar::Util 'refaddr';
use Time::HiRes qw(time);
use MIME::Base64 qw(encode_base64 decode_base64);
use Encode qw(encode FB_DEFAULT);
use IO::Handle;

# KOIC: Kevin's Own ISCABBS Client - Mobile v3 stable
# Changes connection port to 17259
my $Code_version = '3.6.3';


$| = 1;
$SIG{PIPE} = 'IGNORE';
open(STDOUT, '>>', 'koic-test.log') or die "STDOUT: $!";
open(STDERR, '>>', 'koic-test.log') or die "STDERR: $!";

use constant {
    IAC => 255, DONT => 254, DO => 253, WONT => 252, WILL => 251, SB => 250, SE => 240,
    NOP => 241,
    ISCA_BLOCK   => 0xA1,
    ISCA_G_STR   => 0xA2,
    ISCA_G_NAME  => 0xA3,
    ISCA_G_FIVE  => 0xA4,
    ISCA_G_POST  => 0xA5,
    MORE_PROMPT  => 0xAB,
    ISCA_START   => 0xAC,
    ISCA_CONFIG  => 0xAE,
    ISCA_START3  => 0xAF,
    ISCA_CLIENT2 => 0xB0,
    ISCA_CLIENT  => 0xA0,  # Keepalive ping from BBS — must echo back IAC CLIENT
    POST_S => 0xA9,
    POST_E => 0xAA,
    XMSG_S => 0xA7,
    XMSG_E => 0xA8,
    NAWS => 31,
    NEW_ENVIRON => 39,
    CTRL_D => 0x04,
};

my %cfg = ( bbs_host => 'bbs.iscabbs.com', bbs_port => 23, inactivity => 3600 );
my %sessions;

# Same-origin TinyURL helper (used by client-side draft preprocessing).
my $short_ua = Mojo::UserAgent->new;
$short_ua->connect_timeout(3);
$short_ua->inactivity_timeout(6);
my %short_cache;
my @short_cache_order;
my $SHORT_CACHE_MAX = 256;

# Mobile viewport target: 40-column rendering.
my $TERM_COLS = 40;
my $TERM_ROWS = 24;

my $fh = *STDOUT{IO};
$fh->autoflush(1);

# Debug protocol tracing (for temporary test builds).
# Enabled by default; disable with KOIC_TRACE_PROTOCOL=0.
my $trace_fh;
my $trace_enabled = (!defined $ENV{KOIC_TRACE_PROTOCOL} || $ENV{KOIC_TRACE_PROTOCOL} !~ /^(?:0|false|no)$/i);
my $trace_max = ($ENV{KOIC_TRACE_MAX} && $ENV{KOIC_TRACE_MAX} =~ /^\d+$/) ? $ENV{KOIC_TRACE_MAX} : 2048;
my $trace_path = $ENV{KOIC_TRACE_PATH} || 'protocol_trace.log';
my $trace_open_warned = 0;

sub trace_open {
    return if $trace_fh;
    return unless $trace_enabled;
    my $path = $trace_path;

    # Remote deployments often rely on a simple relative path.
    # If an overridden path points at a missing directory, fall back to CWD.
    if (!open($trace_fh, '>>', $path)) {
        my $err = $!;
        if ($path ne 'protocol_trace.log') {
            if (open($trace_fh, '>>', 'protocol_trace.log')) {
                $path = 'protocol_trace.log';
            } else {
                $trace_fh = undef;
                print $fh "[WARN] Could not open protocol trace log ($trace_path): $err\n" unless $trace_open_warned++;
                return;
            }
        } else {
            $trace_fh = undef;
            print $fh "[WARN] Could not open protocol trace log ($trace_path): $err\n" unless $trace_open_warned++;
            return;
        }
    }

    if ($trace_fh) {
        $trace_fh->autoflush(1);
        my $stamp = scalar(localtime());
        print $trace_fh "\n==== KOIC $Code_version pid=$$ $stamp ====" . "\n";
        print $fh "[INFO] KOIC $Code_version protocol tracing: $path\n";
    }
}

sub trace_dump {
    my ($tx_id, $dir, $bytes_ref) = @_;
    return unless $trace_fh && $bytes_ref;
    my @bytes = @$bytes_ref;
    my $trunc = 0;
    if (@bytes > $trace_max) {
        @bytes = @bytes[0 .. ($trace_max - 1)];
        $trunc = 1;
    }
    my $hex = join(' ', map { sprintf('%02X', $_) } @bytes);
    my $stamp = scalar(localtime());
    my $suffix = $trunc ? " ... (truncated)" : "";
    print $trace_fh "$stamp [koic=$Code_version pid=$$ tx=$tx_id] [$dir] $hex$suffix\n";
}

sub bbs_text_to_bytes {
    my ($text) = @_;
    return '' unless defined $text;

    $text =~ s/\x{00A0}/ /g;
    $text =~ s/\x{2018}|\x{2019}/'/g;
    $text =~ s/\x{201C}|\x{201D}/"/g;
    $text =~ s/\x{2013}|\x{2014}/-/g;
    $text =~ s/\x{2026}/.../g;

    return encode('cp437', $text, FB_DEFAULT);
}

sub submit_name_input {
    my ($s, $name_type, $raw_name) = @_;
    $raw_name //= '';

    my $name = $raw_name;
    $name =~ s/[\r\n]+//g;
    $name =~ s/^\s+|\s+$//g;

    # Enemy-list block for outbound Xpress: recipient entry is G_NAME type 2.
    if (($name_type // 0) == 2 && $name ne '' && is_enemy($name, $s->{enemy_list})) {
        my $pkt = pack('C2', IAC, ISCA_BLOCK) . "\n"; # blank recipient cancels/backs out
        bbs_queue_write($s, $pkt);
        # Do not emit a full SGR reset (0m): some BBS screens rely on bold (1) to
        # keep "bright" colors, and 0m can make everything after this look dim.
        # Reset only the foreground color back to default.
        eval { $s->{c}->send({binary => "\r\n\x1b[1;31m[KOIC BLOCKED outgoing Xpress to $name]\x1b[39m\x1b[1m\r\n"}); 1 };
        return;
    }

    my $name_bytes = bbs_text_to_bytes($name);
    my $pkt = pack('C2', IAC, ISCA_BLOCK) . $name_bytes . "\n";
    bbs_queue_write($s, $pkt);
}

sub extract_sender {
    my ($text) = @_;
    return '' unless defined $text && $text ne '';

    my $clean = $text;
    # Strip common ANSI CSI sequences so we can reliably match "from NAME".
    $clean =~ s/\x1b\[[0-9;]*[A-Za-z]//g;
    if ($clean =~ /from\s+([A-Za-z0-9_]+)/i) {
        return $1;
    }
    return '';
}

sub is_enemy {
    my ($sender, $enemy_list_ref) = @_;
    return 0 unless $sender && $enemy_list_ref && ref($enemy_list_ref) eq 'ARRAY';
    my %enemies = map { lc($_) => 1 } grep { defined($_) && $_ ne '' } @$enemy_list_ref;
    return exists $enemies{lc($sender)};
}

sub bbs_flush_write {
    my ($s) = @_;
    return unless $s && $s->{sock};
    return unless defined $s->{outbuf} && length $s->{outbuf};

    while (length $s->{outbuf}) {
        my $written = syswrite($s->{sock}, $s->{outbuf});
        if (defined $written) {
            last if $written == 0;
            substr($s->{outbuf}, 0, $written, '');
            next;
        }

        return if $!{EAGAIN} || $!{EWOULDBLOCK};
        die "bbs_flush_write syswrite failed: $!";
    }

    # Buffer fully drained — stop watching for writability.
    if ($s->{sock} && !length($s->{outbuf})) {
        Mojo::IOLoop->singleton->reactor->watch($s->{sock}, 1, 0);
    }
}

sub bbs_queue_write {
    my ($s, $data) = @_;
    return unless $s && defined $data;

    trace_open();

    if (utf8::is_utf8($data)) {
        my $copy = $data;
        if (utf8::downgrade($copy, 1)) {
            $data = $copy;
        } else {
            $data = bbs_text_to_bytes($data);
        }
    }

    my $tx_id = $s->{tx_id};
    if ($trace_fh && defined $tx_id) {
        my @out = unpack('C*', $data);
        trace_dump($tx_id, 'TX', \@out);
    }

    $s->{outbuf} .= $data;

    if (length($s->{outbuf}) && $s->{sock}) {
        eval { bbs_flush_write($s); 1 } or do {
            my $err = $@ || 'unknown';
            $err =~ s/\s+$//;
            my $tx_id = $s->{tx_id};
            print $fh "[ERROR] Immediate write flush failed: $err\n";
            bbs_disconnect($tx_id, "BBS write failed ($err)") if defined $tx_id;
        };
        # If buffer still has data after flush attempt, arm writability watch.
        if ($s->{sock} && length($s->{outbuf})) {
            Mojo::IOLoop->singleton->reactor->watch($s->{sock}, 1, 1);
        }
    }
}

sub bbs_disconnect {
    my ($tx_id, $reason) = @_;
    my $s = $sessions{$tx_id};
    return unless $s;
    my $c = $s->{c};
    my $msg = $reason || 'BBS disconnected';
    eval {
        $c->send({binary => "\r\n\r\n[KOIC: $msg]\r\n"});
        $c->finish;
        1;
    };
    cleanup_session($tx_id);
}

sub wrap_post_text {
    my ($text, $width) = @_;
    $width ||= 78;
    $text //= '';
    $text =~ s/\r\n/\n/g;
    $text =~ s/\r/\n/g;

    my $split_long_word = sub {
        my ($w) = @_;
        $w //= '';
        return ('') if $w eq '';
        my @parts;
        while (length($w) > $width) {
            my $chunk = substr($w, 0, $width);

            # Prefer splitting URLs/paths on a delimiter to keep chunks readable.
            my $best = -1;
            for my $d ('/', '?', '&', '=', '#', '-', '_') {
                my $pos = rindex($chunk, $d);
                $best = $pos if $pos > $best;
            }

            # Only use a delimiter split if it doesn't create a tiny fragment.
            if ($best >= int($width * 0.6)) {
                $chunk = substr($w, 0, $best + 1);
            }

            push @parts, $chunk;
            $w = substr($w, length($chunk));
        }
        push @parts, $w if length($w);
        return @parts;
    };

    my @paras = split(/\n{2,}/, $text, -1);
    my @out;

    for my $p (@paras) {
        if (!defined($p) || $p =~ /^\s*\z/) {
            push @out, '';
            next;
        }

        if ($p =~ /^(?:[ \t]|>)/m) {
            my $keep = $p;
            $keep =~ s/[ \t]+$//mg;
            push @out, $keep;
            next;
        }

        my $norm = $p;
        $norm =~ s/\n/ /g;
        $norm =~ s/\s+/ /g;
        $norm =~ s/^\s+|\s+$//g;

        my @words = split(/ /, $norm);
        my @lines;
        my $line = '';
        for my $w (@words) {
            my @wparts = (length($w) > $width) ? $split_long_word->($w) : ($w);
            for my $wp (@wparts) {
                next if !defined($wp) || $wp eq '';

                if ($line eq '') {
                    $line = $wp;
                    next;
                }
                if (length($line) + 1 + length($wp) <= $width) {
                    $line .= " $wp";
                } else {
                    push @lines, $line;
                    $line = $wp;
                }
            }
        }
        push @lines, $line if $line ne '';
        push @out, join("\n", @lines);
    }

    return join("\n\n", @out);
}

get '/' => sub { shift->render(template => 'index', code_version => $Code_version) };

get '/shorten' => sub {
    my $c = shift;
    my $url = $c->param('url') // '';
    $url =~ s/^\s+|\s+$//g;

    return $c->render(text => 'Missing url', status => 400) if $url eq '';
    return $c->render(text => 'Bad url', status => 400) if $url !~ m{^https?://}i;
    return $c->render(text => 'Too long', status => 413) if length($url) > 2048;
    return $c->render(text => 'Bad url', status => 400) if $url =~ /[\x00-\x1F\x7F]/;

    if (exists $short_cache{$url}) {
        return $c->render(text => $short_cache{$url}, status => 200);
    }

    my $api = Mojo::URL->new('https://tinyurl.com/api-create.php');
    $api->query(url => $url);

    $c->render_later;

    $short_ua->get_p($api)->then(sub {
        my ($tx) = @_;
        my $res = $tx->result;
        if (!$res->is_success) {
            $c->render(text => 'Shorten failed', status => 502);
            return;
        }

        my $short = $res->body // '';
        $short =~ s/^\s+|\s+$//g;
        if ($short !~ m{^https?://}i) {
            $c->render(text => 'Shorten failed', status => 502);
            return;
        }

        $short_cache{$url} = $short;
        push @short_cache_order, $url;
        if (@short_cache_order > $SHORT_CACHE_MAX) {
            my $old = shift @short_cache_order;
            delete $short_cache{$old} if defined $old;
        }

        $c->render(text => $short, status => 200);
    })->catch(sub {
        $c->render(text => 'Shorten failed', status => 502);
    });
};

websocket '/bbs' => sub {
    my $c = shift;
    my $tx_id = refaddr($c->tx);
    $c->inactivity_timeout($cfg{inactivity});

    print $fh "[INFO] KOIC $Code_version session open tx=$tx_id\n";

    my $sock = IO::Socket::INET->new(PeerAddr => $cfg{bbs_host}, PeerPort => $cfg{bbs_port}, Proto => 'tcp', Blocking => 0);
    if (!$sock) { $c->send("Connect Error: $!"); return; }
    $sock->autoflush(1);
    $sessions{$tx_id} = {
        tx_id => $tx_id,
        sock => $sock,
        c => $c,
        state => 'TEXT',
        handshake_sent => 0,
        pending_action => '',
        pending_arg => undef,
        sync_counter => 0,
        input_mode => 'NORMAL',
        input_buffer => '',
        password_prompt_time => 0,
        awaiting_name => 0,
        awaiting_name_type => 0,
        username => '',
        ansi => 1,
        name_autofilled => 0,
        moreflag => 0,
        just_finished_post => 0,
        in_post => 0,
        in_xmsg => 0,
        post_buffer => '',
        post_sender => '',
        post_decided => 0,
        post_is_enemy => 0,
        post_streaming => 0,
        post_last_nl => 0,
        xmsg_buffer => '',
        linebuf_plain => '',
        linebuf_ansi_skip => 0,
        linebuf_ansi_csi => 0,
        in_compose => -1,
        compose_buffer => '',
        post_menu_active => 0,
        post_abort_confirm => 0,
        post_draft => '',
        awaiting_five => 0,      # G_FIVE (0xA4) local 5-line entry mode (Xpress/profile/e-list hooks)
        five_which => 0,
        five_lines => [],
        five_linebuf => '',
        enemy_list => [],
        outbuf => '',
        keepalive_id => undef,
    };

    my $keepalive_tx = $tx_id;
    $sessions{$tx_id}->{keepalive_id} = Mojo::IOLoop->recurring(15 => sub {
        my $s = $sessions{$keepalive_tx};
        return unless $s && $s->{sock};
        bbs_queue_write($s, pack('C2', IAC, NOP));
    });

    Mojo::IOLoop->singleton->reactor->io($sock => sub {
        my ($reactor, $writable) = @_;
        my $s = $sessions{$tx_id};
        return unless $s;

        eval { bbs_flush_write($s); 1 } or do {
            my $err = $@ || 'unknown';
            $err =~ s/\s+$//;
            print $fh "[ERROR] Write flush failed: $err\n";
            bbs_disconnect($tx_id, "BBS write failed ($err)");
            return;
        };

        return if $writable;

        my $recv_data = '';
        my $bytes = sysread($sock, $recv_data, 8192);
        if (!defined $bytes) {
            return if $!{EAGAIN} || $!{EWOULDBLOCK};
            print $fh "[ERROR] sysread failed: $!\n";
            bbs_disconnect($tx_id, "BBS read failed ($!)");
            return;
        }
        if ($bytes == 0) {
            print $fh "[INFO] BBS socket closed\n";
            bbs_disconnect($tx_id, "BBS socket closed");
            return;
        }

        my @raw = unpack('C*', $recv_data);
        my $to_browser = '';

        trace_open();
        trace_dump($tx_id, 'RX', \@raw) if $trace_fh;

        for my $b (@raw) {
            if ($s->{state} eq 'TEXT') {
                if ($b == IAC) {
                    $s->{state} = 'IAC_SEEN';
                } else {
                    if ($s->{in_post}) {
                        my $ch = chr($b);
                        $s->{post_buffer} .= $ch;

                        # Once we've decided what to do with this post, cap the buffer size to
                        # avoid unbounded growth during very long forum-info screens.
                        if ($s->{post_decided} && length($s->{post_buffer}) > 8192) {
                            $s->{post_buffer} = substr($s->{post_buffer}, -4096);
                        }

                        # Track newline-termination so we can preserve the old behavior of
                        # ensuring the next prompt starts on its own line.
                        if ($ch eq "\r" || $ch eq "\n") {
                            $s->{post_last_nl} = 1;
                        } else {
                            $s->{post_last_nl} = 0;
                        }

                        # If we've already decided this post is allowed, stream bytes through.
                        if ($s->{post_streaming}) {
                            $to_browser .= $ch;
                        }

                        # Try to decide early (so long posts page correctly). We keep buffering
                        # until we can extract a sender; once known, either stream everything or
                        # suppress the entire post.
                        if (!$s->{post_decided} && length($s->{post_buffer}) >= 16 && ($ch eq "\r" || $ch eq "\n" || $ch eq ' ')) {
                            my $sender = extract_sender($s->{post_buffer});
                            if ($sender ne '') {
                                $s->{post_sender} = $sender;
                                $s->{post_is_enemy} = is_enemy($sender, $s->{enemy_list}) ? 1 : 0;
                                $s->{post_decided} = 1;

                                if (!$s->{post_is_enemy}) {
                                    # Flush what we've buffered so far (including this byte) and
                                    # then continue streaming the rest as it arrives.
                                    $to_browser .= $s->{post_buffer} unless $s->{post_streaming};
                                    $s->{post_streaming} = 1;
                                }
                            }
                        }
                    } elsif ($s->{in_xmsg}) {
                        $s->{xmsg_buffer} .= chr($b);
                    } else {
                        my $ch = chr($b);
                        $to_browser .= $ch;

                        # Maintain a plain-text line buffer (ANSI-stripped) so we can detect
                        # specific BBS messages that reset brightness (0m) and re-assert bold.
                        if ($s->{linebuf_ansi_skip}) {
                            if ($s->{linebuf_ansi_csi}) {
                                # CSI ends on a final byte in 0x40..0x7E.
                                if ($b >= 0x40 && $b <= 0x7E) {
                                    $s->{linebuf_ansi_skip} = 0;
                                    $s->{linebuf_ansi_csi} = 0;
                                }
                            } else {
                                # If this is CSI, keep skipping; otherwise end skip after 1 byte.
                                if ($ch eq '[') {
                                    $s->{linebuf_ansi_csi} = 1;
                                } else {
                                    $s->{linebuf_ansi_skip} = 0;
                                }
                            }
                        } else {
                            if ($b == 0x1B) {
                                $s->{linebuf_ansi_skip} = 1;
                                $s->{linebuf_ansi_csi} = 0;
                            } elsif ($ch eq "\r" || $ch eq "\n") {
                                if ($s->{linebuf_plain} =~ /\bMessage\s+not\s+entered\b/i) {
                                    # The BBS often uses SGR 0 (reset) here, which turns off bold
                                    # and makes subsequent colors look "dim". Re-assert bold.
                                    $to_browser .= "\x1b[1m";
                                }
                                $s->{linebuf_plain} = '';
                            } else {
                                # Keep only readable characters.
                                if ($ch =~ /[A-Za-z0-9\s\-\[\]\(\)\.,'"!?:;]/) {
                                    $s->{linebuf_plain} .= $ch;
                                    $s->{linebuf_plain} = substr($s->{linebuf_plain}, -200) if length($s->{linebuf_plain}) > 200;
                                }
                            }
                        }
                    }
                }
            }
            elsif ($s->{state} eq 'IAC_SEEN') {
                if ($b == IAC) {
                    $to_browser .= chr(255);
                    $s->{state} = 'TEXT';
                }
                elsif ($b == DO || $b == DONT || $b == WILL || $b == WONT) {
                    $s->{state} = 'NEG_OPT';
                    if (!$s->{handshake_sent}) {
                        bbs_queue_write($s, pack('C*', IAC, ISCA_CLIENT2));
                        bbs_queue_write($s, pack('C*', IAC, SB, NEW_ENVIRON, 0, 1, 85, 83, 69, 82, 0, 116, 101, 108, 110, 101, 116, IAC, SE));
                        # NAWS (RFC 1073): tell the BBS we're a narrow mobile terminal.
                        bbs_queue_write($s, pack('C*', IAC, SB, NAWS, 0, $TERM_COLS, 0, $TERM_ROWS, IAC, SE));
                        $s->{handshake_sent} = 1;
                    }
                }
                elsif ($b == SB) {
                    $s->{state} = 'SB_EAT';
                }
                elsif ($b == MORE_PROMPT) {
                    # If we're inside a POST block but haven't started streaming yet, this is
                    # typically the end of the first "page". Normal posts include a sender
                    # early ("from NAME") so we can e-list filter before streaming; forum info
                    # screens often don't, so begin streaming here to avoid the "press space
                    # X times before anything shows" behavior.
                    if ($s->{in_post} && !$s->{post_streaming}) {
                        my $sender = extract_sender($s->{post_buffer});
                        if ($sender ne '') {
                            $s->{post_sender} = $sender;
                            $s->{post_is_enemy} = is_enemy($sender, $s->{enemy_list}) ? 1 : 0;
                            $s->{post_decided} = 1;
                        }

                        # If we still can't identify a sender, treat this as non-filterable
                        # (forum info) and allow streaming.
                        if (!$s->{post_decided}) {
                            $s->{post_decided} = 1;
                            $s->{post_is_enemy} = 0;
                        }

                        if (!$s->{post_is_enemy}) {
                            $to_browser .= $s->{post_buffer};
                            $s->{post_streaming} = 1;
                        }
                    }

                    $s->{moreflag} ^= 1;
                    if ($s->{moreflag}) {
                        if (!$s->{just_finished_post}) {
                            $c->send({binary => "__MORE_PROMPT__"});
                        } else {
                            $s->{just_finished_post} = 0;
                        }
                    }
                    $s->{state} = 'TEXT';
                }
                elsif ($b == POST_S) {
                    $s->{in_post} = 1;
                    $s->{post_buffer} = '';
                    $s->{post_sender} = '';
                    $s->{post_decided} = 0;
                    $s->{post_is_enemy} = 0;
                    $s->{post_streaming} = 0;
                    $s->{post_last_nl} = 0;
                    $s->{just_finished_post} = 0;
                    $s->{moreflag} = 0;
                    $s->{state} = 'TEXT';
                }
                elsif ($b == POST_E) {
                    $s->{in_post} = 0;
                    my $sender = $s->{post_sender} ne '' ? $s->{post_sender} : extract_sender($s->{post_buffer});
                    my $is_enemy = $s->{post_decided} ? ($s->{post_is_enemy} ? 1 : 0) : (is_enemy($sender, $s->{enemy_list}) ? 1 : 0);

                    if ($is_enemy) {
                        # If we never streamed anything, suppress the post and show the marker.
                        # Re-assert bold after the marker to avoid leaving the UI "dim".
                        $to_browser .= "\r\n\x1b[1;31m[KOIC BLOCKED Post from $sender]\x1b[39m\x1b[1m\r\n";
                    } else {
                        # If we couldn't decide early, fall back to original behavior.
                        if (!$s->{post_streaming}) {
                            $to_browser .= $s->{post_buffer};
                        }
                        # Ensure the next prompt starts on its own line.
                        if (!$s->{post_last_nl} && (length($to_browser) && $to_browser !~ /[\r\n]\z/)) {
                            $to_browser .= "\r\n";
                        }
                    }
                    $s->{post_buffer} = '';
                    $s->{just_finished_post} = 1;
                    $s->{state} = 'TEXT';
                }
                elsif ($b == XMSG_S) {
                    $s->{in_xmsg} = 1;
                    $s->{xmsg_buffer} = '';
                    $s->{state} = 'TEXT';
                }
                elsif ($b == XMSG_E) {
                    $s->{in_xmsg} = 0;
                    my $sender = extract_sender($s->{xmsg_buffer});
                    if (is_enemy($sender, $s->{enemy_list})) {
                        $to_browser .= "\r\n\x1b[1;31m[KOIC BLOCKED Xpress from $sender]\x1b[39m\x1b[1m\r\n";
                    } else {
                        $to_browser .= $s->{xmsg_buffer};
                    }
                    if (length($to_browser) && $to_browser !~ /[\r\n]\z/) {
                        $to_browser .= "\r\n";
                    }
                    $s->{xmsg_buffer} = '';
                    $s->{state} = 'TEXT';
                }
                elsif ($b == ISCA_G_POST) {
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'G_POST';
                }
                elsif ($b == ISCA_G_NAME) {
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'G_NAME';
                }
                elsif ($b == ISCA_G_STR) {
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'G_STR';
                }
                elsif ($b == ISCA_G_FIVE) {
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'G_FIVE';
                }
                elsif ($b == ISCA_START) {
                    bbs_queue_write($s, pack('C*', IAC, ISCA_START3));
                    # Some servers re-evaluate terminal size after DOC start; resend NAWS.
                    bbs_queue_write($s, pack('C*', IAC, SB, NAWS, 0, $TERM_COLS, 0, $TERM_ROWS, IAC, SE));
                    $s->{state} = 'TEXT';
                }
                elsif ($b == ISCA_CONFIG) {
                    # BBS-triggered "client config" hook (commonly via "cc").
                    # Traditional clients pop a local config menu here.
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'CONFIG';
                }
                elsif ($b == ISCA_CLIENT) {
                    # BBS keepalive ping — echo IAC CLIENT back immediately.
                    # Without this the BBS times out the session after 20 minutes.
                    bbs_queue_write($s, pack('C*', IAC, ISCA_CLIENT));
                    $s->{state} = 'TEXT';
                }
                elsif ($b >= 0xA0 && $b <= 0xB1) {
                    $s->{state} = 'GET_ARG';
                    $s->{pending_action} = 'IGNORE_GENERIC';
                }
                else {
                    $s->{state} = 'TEXT';
                }
            }
            elsif ($s->{state} eq 'NEG_OPT') {
                bbs_queue_write($s, pack('C*', IAC, WILL, $b));
                $s->{state} = 'TEXT';
            }
            elsif ($s->{state} eq 'SB_EAT') {
                if ($b == IAC) {
                    $s->{state} = 'SB_IAC';
                }
            }
            elsif ($s->{state} eq 'SB_IAC') {
                if ($b == SE) {
                    $s->{state} = 'TEXT';
                } else {
                    $s->{state} = 'SB_EAT';
                }
            }
            elsif ($s->{state} eq 'GET_ARG') {
                $s->{pending_arg} = $b;
                $s->{state} = 'SYNC_EAT';
                $s->{sync_counter} = 0;
            }
            elsif ($s->{state} eq 'SYNC_EAT') {
                $s->{sync_counter}++;
                if ($s->{sync_counter} >= 3) {
                    my $arg = $s->{pending_arg};
                    my $which = $s->{pending_action};
                    $s->{state} = 'TEXT';
                    $s->{pending_action} = '';
                    $s->{pending_arg} = undef;

                    if ($which eq 'G_POST') {
                        $s->{in_compose} = $arg // 0;
                        $s->{compose_buffer} = '';
                        $c->send({binary => "__COMPOSE_START__"});
                    }
                    elsif ($which eq 'G_FIVE') {
                        my $w = $arg // 0;
                        $s->{awaiting_five} = 1;
                        $s->{five_which} = $w;
                        $s->{five_lines} = [];
                        $s->{five_linebuf} = '';
                        $c->send({binary => "__FIVE_START__:$w"});
                    }
                    elsif ($which eq 'CONFIG') {
                        # BBS-triggered "client config" hook (often via "cc").
                        # IMPORTANT: the BBS expects a client response here; otherwise input appears to "die".
                        # koic-d answers with an ISCA_BLOCK line like: "80 24 1\n".
                        my $ansi = $s->{ansi} ? 1 : 0;
                        my $cfg_line = "$TERM_COLS $TERM_ROWS $ansi\n";
                        bbs_queue_write($s, pack('C2', IAC, ISCA_BLOCK) . $cfg_line);

                        # Also open the local web config modal.
                        # Include arg for debugging/forward-compat; UI can ignore it.
                        $c->send({binary => "__CLIENT_CONFIG__:$arg"});
                    }
                    elsif ($which eq 'G_NAME') {
                        my $name_type = $arg // 0;

                        # Auto-fill login name once if the frontend set __LOGIN__.
                        if ($name_type == 1 && $s->{username} && !$s->{name_autofilled}) {
                            # IMPORTANT: flush any prompt text already accumulated so the client
                            # sees "Name:" before we echo/autofill; otherwise WebSocket sends can
                            # reorder visually (meta events arriving before the prompt line).
                            if (length $to_browser) {
                                $c->send({binary => $to_browser});
                                $to_browser = '';
                            }

                            my $u = $s->{username};
                            $u =~ s/[\r\n]+//g;
                            my $b64 = encode_base64($u, '');
                            # Include a newline delimiter so the client can safely parse this
                            # even if frames are coalesced.
                            eval { $c->send({binary => "__AUTOLOGIN_ECHO_NAME__:$b64\n"}); 1 };
                            submit_name_input($s, $name_type, $s->{username});
                            $s->{name_autofilled} = 1;
                        } else {
                            $s->{awaiting_name} = 1;
                            $s->{awaiting_name_type} = $name_type;
                            $s->{input_buffer} = '';
                            $c->send({binary => "__AWAITING_NAME__"});
                        }
                    }
                    elsif ($which eq 'G_STR') {
                        # Flush any pending prompt text (e.g. "Password:") before switching
                        # the client into input mode. Check whether it contains "Password:"
                        # BEFORE flushing so we know which signal to send to the browser.
                        my $is_password_field = ($to_browser =~ /Password:/i);
                        if (length $to_browser) {
                            $c->send({binary => $to_browser});
                            $to_browser = '';
                        }

                        $s->{input_mode} = 'PASSWORD';
                        $s->{input_buffer} = '';
                        $s->{password_prompt_time} = time();
                        # For real password fields, use PASSWORD_MODE (triggers autologin + dot echo).
                        # For other G_STR fields (config info etc.), use AWAITING_STR (plain echo).
                        if ($is_password_field) {
                            $c->send({binary => "__PASSWORD_MODE__"});
                        } else {
                            $c->send({binary => "__AWAITING_STR__"});
                        }
                    }
                }
            }
        }

        eval {
            $c->send({binary => $to_browser}) if length $to_browser && $sessions{$tx_id};
            1;
        } or do {
            print $fh "[WARN] send to browser failed (transaction destroyed), cleaning up\n";
            cleanup_session($tx_id);
        };
    })->watch($sock, 1, 0);

    $c->on(finish => sub {
        print $fh "[INFO] WebSocket closed by browser, cleaning up tx=$tx_id\n";
        cleanup_session($tx_id);
    });

    $c->on(message => sub {
        my ($c, $msg) = @_;
        my $s = $sessions{$tx_id};
        return unless $s;

        # Browser-side WebSocket keepalive ping -- absorb silently.
        if ($msg eq '__PING__') { return; }

        # Client setting: ANSI preference (used for DOC CONFIG handshake).
        if ($msg =~ /^__SET_ANSI__:(\d)/) {
            $s->{ansi} = $1 ? 1 : 0;
            return;
        }

        # Optional: allow frontend to set username for one-shot auto-fill.
        if ($msg =~ /^__LOGIN__:(.*)$/s) {
            my $u = $1 // '';
            $u =~ s/[\r\n]+//g;
            if (!defined($s->{username}) || $s->{username} ne $u) {
                # If the configured username changes, allow a fresh one-shot autofill.
                $s->{name_autofilled} = 0;
            }
            $s->{username} = $u;
            return;
        }

        # Client-managed enemy list (comma or newline-separated). Used to filter incoming posts/xpress.
        if ($msg =~ /^__ENEMIES__:(.*)$/s) {
            my $enemy_str = $1 // '';
            $s->{enemy_list} = [grep { $_ ne '' } map { my $t = $_; $t =~ s/^\s+|\s+$//g; $t } split(/[\n,\r]+/, $enemy_str)];
            return;
        }

        # Compatibility: old mobile used __DO_UPLOAD__. Map it to the v3 draft flow.
        if ($msg =~ /^__DO_UPLOAD__:(.*)$/s) {
            $msg = "__DRAFT__:$1";
        }

        # Local compose CANCEL (editor overlay). If the BBS requested compose (DOC G_POST),
        # it is waiting for a response; simply hiding the editor will leave the session stuck.
        if ($msg eq '__DRAFT_CANCEL__') {
            # If we're in the local post menu (editing a draft), just re-show the menu prompt.
            if ($s->{post_menu_active}) {
                $c->send({binary => "\r\n[KOIC: draft edit cancelled]\r\n"});
                $c->send({binary => "__POST_MENU_PROMPT__"});
                return;
            }

            # Abort compose at the BBS.
            my $pkt = pack('C2', IAC, ISCA_BLOCK) . pack('C', CTRL_D) . 'a';
            bbs_queue_write($s, $pkt);

            $s->{in_compose} = -1;
            $s->{compose_buffer} = '';
            $s->{post_draft} = '';
            $s->{post_abort_confirm} = 0;
            $s->{post_menu_active} = 0;
            $c->send({binary => "\r\n[KOIC: compose cancelled]\r\n"});
            return;
        }

        # Draft submission from the local editor: enter local post menu.
        if ($msg =~ /^__DRAFT__:(.*)$/s) {
            my $draft = $1;

            # Defensive guard: keep draft sizes reasonable to avoid runaway websocket payloads.
            # Override via KOIC_MAX_DRAFT if needed.
            my $max = ($ENV{KOIC_MAX_DRAFT} && $ENV{KOIC_MAX_DRAFT} =~ /^\d+$/) ? int($ENV{KOIC_MAX_DRAFT}) : 20000;
            if (defined($draft) && length($draft) > $max) {
                $draft = substr($draft, 0, $max);
                $c->send({binary => "\r\n[KOIC: draft truncated to $max chars]\r\n"});
            }

            $s->{post_draft} = $draft;
            $s->{post_menu_active} = 1;
            $c->send({binary => "__POST_MENU__"});
            my $b64 = encode_base64($s->{post_draft} // '', '');
            $c->send({binary => "__DRAFT_RENDER__:$b64"});
            return;
        }

        # G_FIVE (0xA4): local five-line entry mode (Xpress/profile/e-list hooks).
        # The BBS expects an ISCA_BLOCK payload of up to 5 lines, newline-terminated.
        if ($s->{awaiting_five}) {
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    my $line = $s->{five_linebuf} // '';
                    $line =~ s/[\r\n]+//g;

                    push @{$s->{five_lines}}, $line;
                    $s->{five_linebuf} = '';

                    my $is_first = (@{$s->{five_lines}} == 1);
                    my $finish = 0;

                    # Compatibility with classic client shortcuts.
                    if ($is_first && $line eq 'PING') {
                        $s->{five_lines} = [''];
                        $finish = 1;
                    } elsif ($line eq 'ABORT') {
                        $finish = 1;
                    } elsif ($line eq '') {
                        # Blank line terminates (and is included in what we send).
                        $finish = 1;
                    } elsif (scalar(@{$s->{five_lines}}) >= 5) {
                        # Safety: hard-cap to 5 lines.
                        $finish = 1;
                    }

                    if ($finish) {
                        my $pkt = pack('C2', IAC, ISCA_BLOCK);
                        for my $l (@{$s->{five_lines}}) {
                            $pkt .= bbs_text_to_bytes($l) . "\n";
                        }
                        bbs_queue_write($s, $pkt);

                        $s->{awaiting_five} = 0;
                        $s->{five_which} = 0;
                        $s->{five_lines} = [];
                        $s->{five_linebuf} = '';
                        $c->send({binary => "__FIVE_END__"});
                        last;
                    } else {
                        $c->send({binary => "__FIVE_PROMPT__"});
                    }
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{five_linebuf}) > 0) {
                        $s->{five_linebuf} = substr($s->{five_linebuf}, 0, -1);
                    }
                    next;
                }

                # Classic client limits each line to 78 chars.
                next if length($s->{five_linebuf}) >= 78;
                $s->{five_linebuf} .= $ch;
            }
            return;
        }

        # Post-action menu keys (local). Do NOT forward to the BBS.
        if ($s->{post_menu_active}) {
            my $choice = $msg;
            $choice =~ s/[\r\n\s]//g;
            $choice = lc(substr($choice, 0, 1) // '');

            if ($s->{post_abort_confirm}) {
                if ($choice eq 'y') {
                    my $pkt = pack('C2', IAC, ISCA_BLOCK) . pack('C', CTRL_D) . 'a';
                    bbs_queue_write($s, $pkt);
                    $s->{post_abort_confirm} = 0;
                    $s->{post_menu_active} = 0;
                    $s->{post_draft} = '';
                    $c->send({binary => "__POST_MENU_END__"});
                    return;
                }
                $s->{post_abort_confirm} = 0;
                $c->send({binary => "\r\n[Abort cancelled]\r\n"});
                $c->send({binary => "__POST_MENU_PROMPT__"});
                return;
            }

            if ($choice eq 'e') {
                my $b64 = encode_base64($s->{post_draft} // '', '');
                $c->send({binary => "__EDIT_DRAFT__:$b64"});
                return;
            }

            if ($choice eq 'p') {
                my $pretty = wrap_post_text($s->{post_draft} // '', 78);
                $pretty =~ s/\n/\r\n/g;
                $c->send({binary => "\r\n" . $pretty . "\r\n"});
                $c->send({binary => "__POST_MENU_PROMPT__"});
                return;
            }

            if ($choice eq 'a') {
                $s->{post_abort_confirm} = 1;
                $c->send({binary => "\r\nAbort: are you sure? (Y/N) -> "});
                return;
            }

            if ($choice eq 's') {
                my $body = wrap_post_text($s->{post_draft} // '', 78);
                $body =~ s/\r\n?|\n/\r/g;
                $body .= "\r" if $body ne '' && $body !~ /\r\z/;
                my $body_bytes = bbs_text_to_bytes($body);
                my $pkt = pack('C2', IAC, ISCA_BLOCK) . $body_bytes . pack('C', CTRL_D) . 's';
                bbs_queue_write($s, $pkt);
                $s->{post_menu_active} = 0;
                $s->{post_draft} = '';
                $c->send({binary => "__POST_MENU_END__"});
                return;
            }

            if ($choice eq 'c') {
                $s->{post_menu_active} = 0;
                $c->send({binary => "__POST_MENU_END__"});
                $c->send({binary => "\r\n[Continue: press Enter message again]\r\n"});
                return;
            }

            $c->send({binary => "__POST_MENU_PROMPT__"});
            return;
        }

        # DOC password mode: collect locally until Enter, then send ISCA_BLOCK payload.
        if (($s->{input_mode} // 'NORMAL') eq 'PASSWORD') {
            my $submitted = 0;
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    next if $submitted;

                    my $pw = $s->{input_buffer} // '';
                    $pw =~ s/[\r\n]+//g;
                    my $pw_bytes = bbs_text_to_bytes($pw);
                    my $pkt = pack('C2', IAC, ISCA_BLOCK) . $pw_bytes . "\n";
                    bbs_queue_write($s, $pkt);

                    $s->{input_mode} = 'NORMAL';
                    $s->{input_buffer} = '';
                    $submitted = 1;
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{input_buffer}) > 0) {
                        $s->{input_buffer} = substr($s->{input_buffer}, 0, -1);
                    }
                    next;
                }

                $s->{input_buffer} .= $ch;
            }
            return;
        }

        # DOC G_NAME mode: collect locally until Enter, then send ISCA_BLOCK payload.
        if ($s->{awaiting_name}) {
            my $submitted = 0;
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    next if $submitted;

                    my $name_type = ($s->{awaiting_name_type} // 0);
                    submit_name_input($s, $name_type, $s->{input_buffer});

                    $s->{awaiting_name} = 0;
                    $s->{awaiting_name_type} = 0;
                    $s->{input_buffer} = '';
                    $submitted = 1;
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{input_buffer}) > 0) {
                        $s->{input_buffer} = substr($s->{input_buffer}, 0, -1);
                    }
                    next;
                }

                $s->{input_buffer} .= $ch;
            }
            return;
        }

        # Normal path: forward raw keystrokes to BBS.
        bbs_queue_write($s, $msg);
    });
};

sub cleanup_session {
    my ($tx_id) = @_;
    my $s = delete $sessions{$tx_id};
    if ($s) {
        Mojo::IOLoop->remove($s->{keepalive_id}) if $s->{keepalive_id};
        Mojo::IOLoop->singleton->reactor->remove($s->{sock});
        $s->{sock}->close;
    }
}

app->secrets(['koic_restoration_2026']);

# Static assets (mobile) live in lib-m/.
app->static->paths->[0] = app->home->rel_file('lib-m');
app->start('daemon', '-l', 'http://127.0.0.1:17259');

__DATA__
@@ index.html.ep
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>KOIC v<%= $code_version %></title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
    <link rel="stylesheet" href="/koic-m.css?v=<%= $code_version %>" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
</head>
<body>
    <div id="start-overlay"><button id="connect-btn" onclick="startSession()">TAP TO CONNECT</button></div>
    <div id="koic-debug-hud"></div>
    <button id="cfg-fab" onclick="openClientConfig()" title="KOIC client settings">CFG</button>
    <div id="terminal-container">
        <div id="terminal" tabindex="0" onclick="focusTerminal()"></div>
        <div id="reading-pane" tabindex="0" onclick="paneClick(event)"></div>
        <input type="text" id="phantom-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <div id="editor-overlay">
            <textarea id="scratchpad" placeholder="Type message..."></textarea>
            <div class="editor-btn-bar">
                <button onclick="cancelEditor()" style="background:#444; color:#FFF; width:40%;">CANCEL</button>
                <button onclick="sendToBBS()" style="background:#33FF33; color:#000; width:50%;">POST</button>
            </div>
        </div>
    </div>
    <div id="mobile-nav-bar">
        <button id="kbd-btn" onclick="focusTerminal()">KBD</button>
        <button id="next-btn" onclick="sendSpace()">NEXT / SPACE</button>
    </div>

    <div id="cfg-overlay" onclick="cfgOverlayClick(event)">
        <div id="cfg-panel" role="dialog" aria-modal="true">
            <div id="cfg-header">
                <div id="cfg-title">KOIC Client Config</div>
                <button id="cfg-close" onclick="closeClientConfig()">CLOSE</button>
            </div>
            <div id="cfg-body">
                <div class="cfg-row">
                    <label for="cfg-ansi">ANSI / color</label>
                    <input id="cfg-ansi" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-autologin">Auto-login</label>
                    <input id="cfg-autologin" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-user">Username</label>
                    <input id="cfg-user" type="text" style="flex:1; background:#111; color:#33FF33; border:2px solid #33FF33; padding:6px; font-family:monospace;">
                </div>
                <div class="cfg-row">
                    <label for="cfg-pass">Password</label>
                    <input id="cfg-pass" type="password" style="flex:1; background:#111; color:#33FF33; border:2px solid #33FF33; padding:6px; font-family:monospace;">
                </div>
                <div class="cfg-row">
                    <label for="cfg-use-pane">Reading pane (mobile view)</label>
                    <input id="cfg-use-pane" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-show-next">Show NEXT / SPACE bar</label>
                    <input id="cfg-show-next" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-shorten">Shorten long URLs (TinyURL)</label>
                    <input id="cfg-shorten" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-select">Selection mode (allow copy)</label>
                    <input id="cfg-select" type="checkbox">
                </div>
                <div class="cfg-row">
                    <label for="cfg-font">Font size</label>
                    <input id="cfg-font" type="range" min="12" max="19" step="1">
                </div>
                <div class="cfg-row cfg-row-col">
                    <label for="cfg-enemies">Enemy list (comma or newline-separated)</label>
                    <textarea id="cfg-enemies" rows="5" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" placeholder="Example:\nBozo1, Bozo2\nSpammer3"></textarea>
                </div>
                <div class="cfg-actions">
                    <button class="cfg-btn" onclick="resetClientConfig()">RESET</button>
                    <button class="cfg-btn" onclick="applyClientConfigFromUI(true)">APPLY</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ARIA live region: mirrors reading pane content as plain text for screen readers -->
    <div id="aria-live-region"
         role="log"
         aria-live="polite"
         aria-atomic="false"
         aria-label="Terminal output"
         style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:-1px;">
    </div>
    <!-- ARIA live region: announces prompts and state changes immediately -->
    <div id="aria-live-region-assertive"
         role="alert"
         aria-live="assertive"
         aria-atomic="true"
         aria-label="Prompt"
         style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:-1px;">
    </div>

    <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
    <script>window.KOIC_VERSION = '<%= $code_version %>';</script>
    <script src="/koic-m.js?v=<%= $code_version %>"></script>
</body>
</html>